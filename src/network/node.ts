import { DAGLedger, NetworkType } from '../core/dag-ledger';
import { Libp2pNetwork } from './libp2p-network';
import { SmokeStore } from './smoke-store';
import { StorageManager } from './storage-manager';
import { AccountBlock } from '../core/dag-block';
import { VoteManager, Vote } from '../core/vote';
import { KeyPair, signData, verifySignature } from '../core/crypto';
import { EventEmitter } from '../core/events';
import { multiaddr } from '@multiformats/multiaddr';

/**
 * Returns a stable per-device ID persisted in localStorage.
 * Unlike libp2p's peerId, this survives page reloads so storage
 * registration correctly identifies which physical device is serving.
 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem('neuronchain_device_id');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('neuronchain_device_id', id); }
    return id;
  } catch { return ''; }
}

export interface NodeStats {
  status: 'stopped' | 'running' | 'validating';
  uptime: number;
  network: NetworkType;
  peerId: string;
  peerCount: number;
  synapses: number;
}

export class NeuronNode extends EventEmitter {
  ledger: DAGLedger;
  /** libp2p P2P network layer */
  net: Libp2pNetwork;
  /** Smoke content store (IndexedDB + HTTP-over-WebRTC) */
  store: SmokeStore;
  /** Storage deal lifecycle manager */
  storage: StorageManager;

  private status: 'stopped' | 'running' | 'validating' = 'stopped';
  private startTime: number | null = null;
  private voteProcessInterval: ReturnType<typeof setInterval> | null = null;
  private resyncInterval: ReturnType<typeof setInterval> | null = null;
  private publishInterval: ReturnType<typeof setInterval> | null = null;
  private resyncDebounce: ReturnType<typeof setTimeout> | null = null;
  private publishDebounce: ReturnType<typeof setTimeout> | null = null;

  localKeys: Map<string, KeyPair> = new Map();
  private processedInbox: Set<string> = new Set();
  private watchedInboxes: Set<string> = new Set();
  private static readonly MAX_INBOX = 10_000;
  private dialingPeers: Set<string> = new Set();

  constructor(network: NetworkType = 'testnet') {
    super();
    this.ledger = new DAGLedger(network);
    this.net = new Libp2pNetwork(network);
    this.store = new SmokeStore();
    this.storage = new StorageManager(this.ledger, this.net, this.store, this.localKeys);
  }

  private eventsWired = false;

  private wireEvents(): void {
    if (this.eventsWired) return;
    this.eventsWired = true;

    this.net.on('account:synced', async (data: unknown) => {
      const acc = data as Record<string, unknown>;
      const pub = String(acc.pub);
      if (acc._sig) {
        const valid = await NeuronNode.verifyAccountData(acc);
        if (!valid) { console.warn(`[Node] Rejected account ${pub.slice(0, 12)}... - invalid signature`); return; }
      }
      // Always register — registerAccount merges into existing or creates new.
      // Dropping known accounts here was the cause of one-way sync: PC created
      // account A, received account B from mobile, but since A was already known
      // the handler returned early and B was never registered.
      this.ledger.registerAccount({
        username: String(acc.username), pub,
        balance: Number(acc.balance || 0), nonce: Number(acc.nonce || 0),
        createdAt: Number(acc.createdAt || 0), faceMapHash: String(acc.faceMapHash || ''),
        linkedAnchor: acc.linkedAnchor ? String(acc.linkedAnchor) : undefined,
        pqPub: acc.pqPub ? String(acc.pqPub) : undefined,
        pqKemPub: acc.pqKemPub ? String(acc.pqKemPub) : undefined,
        pinSalt: acc.pinSalt ? String(acc.pinSalt) : undefined,
        pinVerifier: acc.pinVerifier ? String(acc.pinVerifier) : undefined,
      });
      this.emit('account:synced', acc);
      // A new peer has data — reply with ours so the handshake completes both ways
      if (this.publishDebounce) clearTimeout(this.publishDebounce);
      this.publishDebounce = setTimeout(() => {
        this.publishDebounce = null;
        this.publishLocalData();
      }, 500);
    });

    this.net.on('block:received', async (block: unknown) => {
      const b = block as AccountBlock;
      if (b.type === 'open' && !this.ledger.accounts.has(b.accountPub)) {
        this.ledger.registerAccount({ username: b.accountPub, pub: b.accountPub, balance: 0, nonce: 0, createdAt: b.timestamp, faceMapHash: b.faceMapHash || '' });
      }
      const result = await this.ledger.addBlock(b);
      if (result.success) {
        this.emit('block:received', b);
        this.voteIfConflict(b);
        this.autoReceive(b);
      }
    });

    this.net.on('vote:received', async (vote: unknown) => {
      const v = vote as Vote;
      const valid = await VoteManager.verifyVote(v);
      if (!valid) { console.warn(`[Node] Rejected vote from ${v.voterPub?.slice(0, 12)}... - invalid signature`); return; }
      this.ledger.castVote(v);
      this.emit('vote:received', v);
    });

    this.ledger.on('block:added',      (b: unknown) => this.emit('block:added', b));
    this.ledger.on('block:confirmed',  (b: unknown) => this.emit('block:confirmed', b));
    this.ledger.on('block:conflict',   (b: unknown) => this.emit('block:conflict', b));
    this.ledger.on('block:rejected',   (b: unknown) => this.emit('block:rejected', b));
    this.ledger.on('contract:deployed',(d: unknown) => this.emit('contract:deployed', d));
    this.ledger.on('contract:executed',(d: unknown) => this.emit('contract:executed', d));
    this.ledger.on('contract:error',   (d: unknown) => this.emit('contract:error', d));

    this.net.on('peer:addrs', async (data: unknown) => {
      const { peerId, addrs, smokeAddr } = data as { peerId: string; addrs: string[]; smokeAddr?: string };
      await this.dialPeer(peerId, addrs);
      // Register every peer's smoke Hub address so retrieve() can fetch from any peer
      if (smokeAddr) this.store.addPeerFallback(smokeAddr);
    });

    this.net.on('peer:connected', (id: unknown) => {
      this.emit('peer:connected', id);
      // Re-broadcast all local accounts and blocks so the newly connected
      // peer can sync state. Debounced so rapid multi-peer connections only
      // trigger one publish. 2s delay lets the GossipSub mesh form first.
      if (this.publishDebounce) clearTimeout(this.publishDebounce);
      this.publishDebounce = setTimeout(() => {
        this.publishDebounce = null;
        this.publishLocalData();
      }, 2000);
    });
    this.net.on('peer:disconnected', (id: unknown) => this.emit('peer:disconnected', id));

    this.net.on('generation:changed', (isReset: unknown) => {
      if (isReset) {
        // Real testnet reset from another device — wipe in-memory state and reload
        this.ledger.reset();
        this.localKeys.clear();
        this.processedInbox.clear();
        this.emit('generation:reset'); // → main.ts → location.reload()
      } else {
        // Sync-only generation update (publishLocalData re-broadcast).
        // IDB was NOT cleared, so in-memory state is still valid.
        // Re-publish immediately so our messages pass peers' _gen filter.
        setTimeout(() => this.publishLocalData(), 1000);
      }
    });

    this.storage.on('storage:heartbeat-sent', (d: unknown) => this.emit('storage:heartbeat-sent', d));
    this.storage.on('storage:reward-issued',  (d: unknown) => this.emit('storage:reward-issued', d));
    this.storage.on('storage:cached',          (d: unknown) => this.emit('storage:cached', d));

    for (const pub of this.localKeys.keys()) this.startInboxWatch(pub);
  }

  private async dialPeer(peerId: string, addrs: string[]): Promise<void> {
    if (!this.net.libp2p) return;
    const connected = this.net.libp2p.getConnections().some(c => c.remotePeer.toString() === peerId);
    if (connected) return;
    if (this.dialingPeers.has(peerId)) return;
    this.dialingPeers.add(peerId);
    try {

    // Build simplified circuit-relay addrs from our own existing relay connections.
    // The received addrs may contain transport-specific components like
    // wss/http-path/relay-ws that confuse the circuit-relay transport's dialFilter
    // on some libp2p/multiaddr version combinations, causing "Can't interpret
    // protocol p2p-circuit". The simplified /p2p/{relay}/p2p-circuit format has
    // no such components and the transport reuses the already-open relay connection.
    const constructed: string[] = [];
    for (const conn of this.net.libp2p.getConnections()) {
      const relayId = conn.remotePeer.toString();
      if (relayId !== peerId) {
        constructed.push(`/p2p/${relayId}/p2p-circuit/p2p/${peerId}`);
      }
    }

    const toTry = [...constructed, ...addrs];
    for (const addrStr of toTry) {
      try {
        await this.net.libp2p.dial(multiaddr(addrStr));
        return;
      } catch { /* try next addr */ }
    }
    } finally {
      this.dialingPeers.delete(peerId);
    }
  }

  async connectToKnownPeers(): Promise<void> {
    const known = [...this.net.knownPeerAddrs.entries()];
    const myAddrs = (this.net.libp2p?.getMultiaddrs?.() ?? []).map(a => a.toString());
    const conns = (this.net.libp2p?.getConnections?.() ?? []).map(c => c.remotePeer.toString());
    for (const [peerId, addrs] of known) {
      await this.dialPeer(peerId, addrs);
    }
  }

  private async voteIfConflict(block: AccountBlock): Promise<void> {
    if (this.ledger.votes.getStatus(block.hash) !== 'conflict') return;
    for (const [pub, keys] of this.localKeys) {
      const balance = this.ledger.getAccountBalance(pub);
      if (balance <= 0) continue;
      const head = this.ledger.getAccountHead(pub);
      const vote = await VoteManager.createVote(block.hash, true, balance, keys, head?.hash);
      this.ledger.castVote(vote);
      this.net.publishVote(vote);
    }
  }

  private async autoReceive(block: AccountBlock): Promise<void> {
    if (block.type !== 'send' || !block.recipient) return;
    const keys = this.localKeys.get(block.recipient);
    if (!keys) return;
    setTimeout(async () => {
      const result = await this.ledger.createReceive(block.recipient!, block.hash, keys);
      if (result.block) {
        await this.ledger.addBlock(result.block);
        this.net.publishBlock(result.block);
        this.emit('auto:received', { from: block.accountPub, amount: block.amount });
      }
    }, 500);
  }

  // Sweep ledger.unclaimedSends for any sends addressed to local keys and
  // auto-receive them. This is the fallback path for missed auto-receives.
  //
  // Why this is needed:
  //   autoReceive() fires from the block:received event, which is only emitted
  //   once per block hash (processedBlocks dedup prevents re-emission on
  //   gossipsub re-broadcasts). If the recipient's node missed that single
  //   delivery window - e.g. the gossipsub mesh hadn't fully formed yet when
  //   the sender first published the block - the receive is never created and
  //   no amount of re-broadcasting will fix it via the event path.
  //
  //   sweepUnclaimedReceives() bypasses gossipsub entirely and works directly
  //   off ledger.unclaimedSends, which is populated whenever a send block is
  //   successfully added to the ledger (regardless of how it arrived).
  //
  // Called: 4s after node start, every 20s alongside publishLocalData(),
  //         and 1s after addLocalKey() (covers sends that arrived before
  //         the user recovered their keys).
  private async sweepUnclaimedReceives(): Promise<void> {
    for (const [pub, keys] of this.localKeys) {
      const unclaimed = this.ledger.getUnclaimedForAccount(pub);
      for (const { sendBlockHash, fromPub, amount } of unclaimed) {
        const result = await this.ledger.createReceive(pub, sendBlockHash, keys);
        if (result.block) {
          await this.ledger.addBlock(result.block);
          this.net.publishBlock(result.block);
          this.emit('auto:received', { from: fromPub, amount });
        }
      }
    }
  }

  private startInboxWatch(pub: string): void {
    if (this.watchedInboxes.has(pub)) return;
    this.watchedInboxes.add(pub);
    this.net.watchInbox(pub, async (signal) => {
      const key = `${signal.blockHash}:${signal.sender}`;
      if (this.processedInbox.has(key)) return;
      if (signal.signature) {
        const payload = `inbox:${signal.blockHash}:${signal.sender}:${pub}:${signal.amount}`;
        const result = await verifySignature(signal.signature, signal.sender);
        if (result !== payload) { console.warn(`[Inbox] Rejected signal - invalid signature`); return; }
      }
      this.processedInbox.add(key);
      if (this.processedInbox.size > NeuronNode.MAX_INBOX) {
        const first = this.processedInbox.values().next().value!;
        this.processedInbox.delete(first);
      }
      this.emit('inbox:signal', signal);
      if (!this.ledger.allBlocks.has(signal.blockHash)) this.resyncAccount(signal.sender);
    });
  }

  private async resyncAccount(accountPub: string): Promise<void> {
    try {
      if (!this.ledger.accounts.has(accountPub)) {
        const accData = await this.net.loadAccount(accountPub);
        if (accData?.username) {
          if (accData._sig) {
            const valid = await NeuronNode.verifyAccountData(accData);
            if (!valid) { console.warn(`[Resync] Rejected account - invalid signature`); return; }
          }
          let faceDescriptor: number[] | undefined;
          if (accData.faceDescriptor) { try { faceDescriptor = JSON.parse(String(accData.faceDescriptor)); } catch {} }
          this.ledger.registerAccount({
            username: String(accData.username), pub: String(accData.pub || accountPub),
            balance: Number(accData.balance || 0), nonce: Number(accData.nonce || 0),
            createdAt: Number(accData.createdAt || 0), faceMapHash: String(accData.faceMapHash || ''),
            faceDescriptor,
            linkedAnchor: accData.linkedAnchor ? String(accData.linkedAnchor) : undefined,
            pqPub: accData.pqPub ? String(accData.pqPub) : undefined,
            pqKemPub: accData.pqKemPub ? String(accData.pqKemPub) : undefined,
            pinSalt: accData.pinSalt ? String(accData.pinSalt) : undefined,
            pinVerifier: accData.pinVerifier ? String(accData.pinVerifier) : undefined,
          });
        }
      }
      const blocks = await this.net.loadAccountChain(accountPub);
      let newBlocks = 0;
      for (const block of blocks) {
        if (!this.ledger.allBlocks.has(block.hash)) {
          const result = await this.ledger.addBlock(block);
          if (result.success) { newBlocks++; this.voteIfConflict(block); this.autoReceive(block); }
        }
      }
      if (newBlocks > 0) { this.emit('resync', { newAccounts: 0, newBlocks }); }
    } catch (err) { console.error('[Resync] error:', err); }
  }

  addLocalKey(pub: string, keys: KeyPair): void {
    this.localKeys.set(pub, keys);
    if (this.status !== 'stopped') {
      this.startInboxWatch(pub);
      setTimeout(() => this.sweepUnclaimedReceives(), 1000);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.status !== 'stopped') return;
    await this.net.start();
    await this.store.start();
    // Push our smoke Hub address into peer-addrs broadcasts so every peer
    // can reach us for content retrieval even if they missed our CacheRequests.
    this.store.getSmokeHostname().then(addr => { if (addr) this.net.setSmokeAddr(addr); });
    this.storage.start();
    this.wireEvents();

    const [chains, accounts, contracts] = await Promise.all([
      this.net.loadAccountChains(),
      this.net.loadAccounts(),
      this.net.loadContracts(),
    ]);

    for (const [pub, accData] of accounts) {
      let faceDescriptor: number[] | undefined;
      if (accData.faceDescriptor) { try { faceDescriptor = JSON.parse(String(accData.faceDescriptor)); } catch {} }
      this.ledger.registerAccount({
        username: String(accData.username || ''), pub: String(accData.pub || pub),
        balance: Number(accData.balance || 0), nonce: Number(accData.nonce || 0),
        createdAt: Number(accData.createdAt || 0), faceMapHash: String(accData.faceMapHash || ''),
        faceDescriptor,
        linkedAnchor: accData.linkedAnchor ? String(accData.linkedAnchor) : undefined,
        pqPub: accData.pqPub ? String(accData.pqPub) : undefined,
        pqKemPub: accData.pqKemPub ? String(accData.pqKemPub) : undefined,
        pinSalt: accData.pinSalt ? String(accData.pinSalt) : undefined,
        pinVerifier: accData.pinVerifier ? String(accData.pinVerifier) : undefined,
      });
    }

    for (const [, chain] of chains) {
      for (const block of chain) await this.ledger.addBlock(block);
    }

    this.ledger.rebuildFaceAccountCount();

    for (const [id, cData] of contracts) {
      if (!this.ledger.contracts.has(id)) {
        this.ledger.contracts.set(id, {
          owner: String(cData.owner || ''), code: String(cData.code || ''),
          state: {}, name: String(cData.name || ''), deployedAt: Number(cData.deployedAt || 0),
        });
      }
    }

    this.voteProcessInterval = setInterval(() => this.ledger.processConflicts(), 3000);
    this.resyncInterval = setInterval(() => this.resyncFromNet(), 60_000);
    // Re-publish every 20s so late-joining peers receive our data within one cycle
    this.publishInterval = setInterval(() => {
      this.publishLocalData();
      this.sweepUnclaimedReceives();
    }, 20_000);

    // Publish local state once on startup so any already-connected peers receive it
    setTimeout(() => this.publishLocalData(), 3000);
    // Sweep for any unclaimed sends that arrived before keys were loaded
    setTimeout(() => this.sweepUnclaimedReceives(), 4000);

    this.status = 'running';
    this.startTime = Date.now();
    this.emit('node:started');
  }

  private async resyncFromNet(): Promise<void> {
    try {
      const accounts = await this.net.loadAccounts();
      let newAccounts = 0;
      for (const [pub, accData] of accounts) {
        if (!accData.username) continue;
        if (accData._sig) {
          const valid = await NeuronNode.verifyAccountData(accData);
          if (!valid) continue;
        }
        const existing = this.ledger.accounts.has(pub);
        let faceDescriptor: number[] | undefined;
        if (accData.faceDescriptor) { try { faceDescriptor = JSON.parse(String(accData.faceDescriptor)); } catch {} }
        this.ledger.registerAccount({
          username: String(accData.username), pub: String(accData.pub || pub),
          balance: Number(accData.balance || 0), nonce: Number(accData.nonce || 0),
          createdAt: Number(accData.createdAt || 0), faceMapHash: String(accData.faceMapHash || ''),
          faceDescriptor,
          linkedAnchor: accData.linkedAnchor ? String(accData.linkedAnchor) : undefined,
          pqPub: accData.pqPub ? String(accData.pqPub) : undefined,
          pqKemPub: accData.pqKemPub ? String(accData.pqKemPub) : undefined,
          pinSalt: accData.pinSalt ? String(accData.pinSalt) : undefined,
          pinVerifier: accData.pinVerifier ? String(accData.pinVerifier) : undefined,
        });
        if (!existing) newAccounts++;
      }

      const chains = await this.net.loadAccountChains();
      let newBlocks = 0;
      for (const [accountPub, chain] of chains) {
        if (!this.ledger.accounts.has(accountPub)) {
          this.ledger.registerAccount({ username: accountPub.slice(0, 16), pub: accountPub, balance: 0, nonce: 0, createdAt: Date.now(), faceMapHash: '' });
        }
        for (const block of chain) {
          if (!this.ledger.allBlocks.has(block.hash)) {
            const result = await this.ledger.addBlock(block);
            if (result.success) { newBlocks++; this.voteIfConflict(block); this.autoReceive(block); }
          }
        }
      }
      if (newAccounts > 0 || newBlocks > 0) {
        this.ledger.rebuildFaceAccountCount();
        this.emit('resync', { newAccounts, newBlocks });
      }
    } catch (err) { console.error('[Resync] error:', err); }
  }

  requestResync(): void {
    if (this.status === 'stopped') return;
    if (this.resyncDebounce) clearTimeout(this.resyncDebounce);
    this.resyncDebounce = setTimeout(() => { this.resyncDebounce = null; this.resyncFromNet(); }, 500);
  }

  private async signAccountData(acc: Record<string, unknown>, keys: KeyPair): Promise<Record<string, unknown>> {
    const payload = `account:${acc.pub}:${acc.username}:${acc.createdAt}:${acc.faceMapHash}`;
    const signature = await signData(payload, keys);
    return { ...acc, _sig: signature };
  }

  private static async verifyAccountData(acc: Record<string, unknown>): Promise<boolean> {
    if (!acc._sig || !acc.pub) return false;
    const payload = `account:${acc.pub}:${acc.username}:${acc.createdAt}:${acc.faceMapHash}`;
    const result = await verifySignature(String(acc._sig), String(acc.pub));
    return result === payload;
  }

  async publishLocalData(): Promise<void> {
    // Re-broadcast generation so late-joining peers can catch up and pass the
    // _gen filter. The reload is now suppressed when a fresh device (no blocks)
    // receives a higher generation, so this no longer causes spurious reloads.
    this.net.publishGeneration();

    let published = 0;
    for (const [pub, acc] of this.ledger.accounts) {
      const keys = this.localKeys.get(pub);
      const accData: Record<string, unknown> = {
        username: acc.username, pub: acc.pub, balance: acc.balance, nonce: acc.nonce,
        createdAt: acc.createdAt, faceMapHash: acc.faceMapHash,
        faceDescriptor: acc.faceDescriptor ? JSON.stringify(acc.faceDescriptor) : undefined,
        linkedAnchor: acc.linkedAnchor ?? undefined,
        pqPub: acc.pqPub ?? undefined,
        pqKemPub: acc.pqKemPub ?? undefined,
        pinSalt: acc.pinSalt ?? undefined,
        pinVerifier: acc.pinVerifier ?? undefined,
      };
      this.net.saveAccount(pub, keys ? await this.signAccountData(accData, keys) : accData);
    }
    for (const [, block] of this.ledger.allBlocks) { this.net.publishBlock(block); published++; }

    // Re-gossip local key blobs so recovering devices can fetch them without being online at enrollment
    for (const pub of this.localKeys.keys()) {
      const blob = await this.net.loadKeyBlob(pub);
      if (blob) this.net.saveKeyBlob(pub, blob);
    }
  }

  async stop(): Promise<void> {
    this.stopValidating();
    if (this.voteProcessInterval) { clearInterval(this.voteProcessInterval); this.voteProcessInterval = null; }
    if (this.resyncInterval) { clearInterval(this.resyncInterval); this.resyncInterval = null; }
    if (this.publishInterval) { clearInterval(this.publishInterval); this.publishInterval = null; }
    if (this.resyncDebounce) { clearTimeout(this.resyncDebounce); this.resyncDebounce = null; }
    if (this.publishDebounce) { clearTimeout(this.publishDebounce); this.publishDebounce = null; }
    this.storage.stop();
    await this.store.stop();
    await this.net.stop();
    this.net.removeAllListeners();
    this.ledger.removeAllListeners();
    this.eventsWired = false;
    this.processedInbox.clear();
    this.watchedInboxes.clear();
    this.status = 'stopped';
    this.startTime = null;
    this.emit('node:stopped');
  }

  startValidating(): void {
    if (this.status === 'stopped') return;
    this.status = 'validating';
    this.emit('validating:started');
  }

  stopValidating(): void {
    if (this.status === 'validating') { this.status = 'running'; this.emit('validating:stopped'); }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async submitBlock(block: AccountBlock): Promise<{ success: boolean; error?: string }> {
    const result = await this.ledger.addBlock(block);
    if (result.success) {
      this.net.publishBlock(block);
      this.voteIfConflict(block);
      if (block.type === 'send' && block.recipient) {
        const keys = this.localKeys.get(block.accountPub);
        let inboxSig: string | undefined;
        if (keys) {
          const payload = `inbox:${block.hash}:${block.accountPub}:${block.recipient}:${block.amount ?? 0}`;
          inboxSig = await signData(payload, keys);
        }
        this.net.publishInboxSignal(block.recipient, block.accountPub, block.hash, block.amount ?? 0, inboxSig);
      }
    }
    return result;
  }

  /** Register as a storage provider. capacityGB = 0 deregisters. */
  async registerStorage(pub: string, capacityGB: number, keys: KeyPair): Promise<{ success: boolean; error?: string }> {
    const result = await this.ledger.createStorageRegister(pub, capacityGB, keys, getDeviceId());
    if (!result.block) return { success: false, error: result.error };
    return this.submitBlock(result.block);
  }

  /** Deregister from the storage ledger entirely. */
  async deregisterStorage(pub: string, keys: KeyPair): Promise<{ success: boolean; error?: string }> {
    const result = await this.ledger.createStorageDeregister(pub, keys);
    if (!result.block) return { success: false, error: result.error };
    return this.submitBlock(result.block);
  }

  /** Distribute stored CIDs to up to 10 network providers. Pass all CIDs that must be pinned together (e.g. metaCid + contentCid). */
  async distributeContent(cids: string | string[], uploaderPub: string, keys: KeyPair): Promise<{ providers: string[]; error?: string }> {
    const cidArr = Array.isArray(cids) ? cids : [cids];
    return this.storage.distributeContent(cidArr[0], uploaderPub, keys, cidArr.slice(1));
  }

  /**
   * Delete content from local storage and broadcast a signed delete request so
   * all caching providers also drop their copies immediately.
   */
  async deleteContent(cids: string[], ownerPub: string, keys: KeyPair): Promise<void> {
    // Delete locally first
    for (const cid of cids) {
      await this.store.deleteBlock(cid);
    }
    // Broadcast to providers
    const ts = Date.now();
    const payload = `delete:${cids.join(',')}:${ownerPub}:${ts}`;
    const signature = await signData(payload, keys);
    this.net.publishDeleteRequest({ cids, ownerPub, timestamp: ts, signature });
  }

  getStats(): NodeStats {
    const netStats = this.net.getStats();
    return {
      status: this.status, uptime: this.startTime ? Date.now() - this.startTime : 0,
      network: this.ledger.network, peerId: netStats.peerId,
      peerCount: netStats.peerCount, synapses: netStats.synapses,
    };
  }

  async switchNetwork(network: NetworkType): Promise<void> {
    const wasRunning = this.status !== 'stopped';
    if (wasRunning) await this.stop();
    this.ledger = new DAGLedger(network);
    this.net = new Libp2pNetwork(network);
    this.emit('network:switched', network);
  }
}
