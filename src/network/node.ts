import { DAGLedger, NetworkType } from '../core/dag-ledger';
import { Libp2pNetwork } from './libp2p-network';
import { SmokeStore, GossipSubAdapter } from './smoke-store';
import { StorageManager } from './storage-manager';
import { AccountBlock } from '../core/dag-block';
import { VoteManager, Vote } from '../core/vote';
import { KeyPair, signData, verifySignature } from '../core/crypto';
import { EventEmitter } from '../core/events';
import { multiaddr } from '@multiformats/multiaddr';
import { createSnapshot, parseSnapshot, SNAPSHOT_TRIGGER_BYTES } from '../core/snapshot';

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
  /** P2/C3: blocks waiting for their parent to arrive, keyed by previousHash. Entries older than 5 min are evicted. */
  private pendingBlocks: Map<string, { blocks: AccountBlock[]; addedAt: number }> = new Map();
  private static readonly PENDING_BLOCK_TTL_MS = 5 * 60 * 1000;
  /** P7: accounts dirtied by incoming blocks since last resync - gate for skipping idle resync passes */
  private dirtyAccounts: Set<string> = new Set();
  /** P1: timestamp of the last publishLocalData call; used to skip already-published blocks */
  private lastPublishedAt = 0;
  /** P4: highest account _version seen in IDB at the last resync; drives incremental loadChangedAccounts */
  private lastSyncedAccountVersion = 0;
  /** A5: highest block _blockVersion seen in IDB at the last resync; drives incremental loadBlocksSince */
  private lastSyncedBlockVersion = 0;

  localKeys: Map<string, KeyPair> = new Map();
  private processedInbox: Set<string> = new Set();
  /** A8: snapshot tracking */
  private lastSnapshotBytes = 0;
  private snapshotPending = false;
  private watchedInboxes: Set<string> = new Set();
  private static readonly MAX_INBOX = 10_000;
  private dialingPeers: Set<string> = new Set();
  private relayLivenessInterval: ReturnType<typeof setInterval> | null = null;

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
      // Always register - registerAccount merges into existing or creates new.
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
      // A new peer has data - reply with ours so the handshake completes both ways
      if (this.publishDebounce) clearTimeout(this.publishDebounce);
      this.publishDebounce = setTimeout(() => {
        this.publishDebounce = null;
        this.publishLocalData();
      }, 500);
    });

    this.net.on('block:received', async (block: unknown) => {
      await this.handleIncomingBlock(block as AccountBlock);
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

    // G4: persist contract state to IDB whenever it changes
    this.ledger.on('contract:state-changed', async (d: unknown) => {
      const { contractId, state } = d as { contractId: string; state: Record<string, unknown> };
      const contract = this.ledger.contracts.get(contractId);
      if (contract) {
        await this.net.saveContract(contractId, { owner: contract.owner, code: contract.code, name: contract.name, deployedAt: contract.deployedAt, state });
      }
    });

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

    // A8: apply a gossipped snapshot if the ledger is empty (bootstrap path)
    this.net.on('snapshot:announced', async (info: unknown) => {
      const { cid } = info as { cid: string; sizeBytes: number; epochBlock: string };
      if (this.ledger.allBlocks.size > 0) return;
      try {
        const data = await this.store.retrieve(cid, 60_000);
        if (data) await this.applySnapshot(data);
      } catch { /* snapshot unavailable - normal sync will follow */ }
    });

    this.net.on('generation:changed', (isReset: unknown) => {
      if (isReset) {
        // Real testnet reset from another device - wipe in-memory state and reload
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
    for (const [peerId, entry] of known) {
      await this.dialPeer(peerId, entry.addrs);
    }
  }

  /** P2: attempt to add a block and retry any queued children on success */
  private async handleIncomingBlock(b: AccountBlock): Promise<void> {
    if (b.type === 'open' && !this.ledger.accounts.has(b.accountPub)) {
      this.ledger.registerAccount({ username: b.accountPub, pub: b.accountPub, balance: 0, nonce: 0, createdAt: b.timestamp, faceMapHash: b.faceMapHash || '' });
    }
    const result = await this.ledger.addBlock(b);
    if (result.success) {
      this.emit('block:received', b);
      this.voteIfConflict(b);
      this.autoReceive(b);
      // Flush any children that were waiting for this block as their parent
      const entry = this.pendingBlocks.get(b.hash);
      if (entry) {
        this.pendingBlocks.delete(b.hash);
        for (const child of entry.blocks) await this.handleIncomingBlock(child);
      }
      // P7: mark account as dirty so resyncFromNet knows something changed
      this.dirtyAccounts.add(b.accountPub);
    } else if (result.error === 'previousHash mismatch') {
      // Parent not yet received - queue the block and clear it from gossip dedup
      // so it can be retried if re-broadcast, OR when the parent arrives above.
      this.net.forgetBlock(b.hash);
      // C3: evict stale pending entries before adding
      const now = Date.now();
      for (const [k, v] of this.pendingBlocks) {
        if (now - v.addedAt > NeuronNode.PENDING_BLOCK_TTL_MS) this.pendingBlocks.delete(k);
      }
      const existing = this.pendingBlocks.get(b.previousHash);
      if (existing) {
        existing.blocks.push(b);
      } else {
        this.pendingBlocks.set(b.previousHash, { blocks: [b], addedAt: now });
      }
    } else {
      // Allow the re-broadcast cycle to retry other transient failures.
      this.net.forgetBlock(b.hash);
    }
  }

  /** G6 + S8: vote to approve the earliest block in a conflict; reject locked accounts; abstain when chain context is missing */
  private async voteIfConflict(block: AccountBlock): Promise<void> {
    if (this.ledger.votes.getStatus(block.hash) !== 'conflict') return;

    // G6: if the block's parent is not in our ledger, we cannot make an informed
    // approve/reject decision. Send an abstain vote so finalization knows we
    // participated but lack context - this prevents uninformed votes from biasing
    // the outcome and pushes conflicts toward the timestamp-ordered timeout path.
    const hasParentContext = block.index === 0 || this.ledger.allBlocks.has(block.previousHash);
    if (!hasParentContext) {
      for (const [pub, keys] of this.localKeys) {
        const balance = this.ledger.getAccountBalance(pub);
        if (balance <= 0) continue;
        const head = this.ledger.getAccountHead(pub);
        const vote = await VoteManager.createVote(block.hash, false, balance, keys, head?.hash, true);
        this.ledger.castVote(vote);
        this.net.publishVote(vote);
      }
      return;
    }

    // S8: blocks from locked accounts are always rejected in conflict resolution
    const isLocked = this.net.isLockedOut(block.accountPub);
    // G6: prefer the block with the smallest timestamp; break ties by hash
    const siblings = this.ledger.votes.getSiblings(block.hash);
    let approve = !isLocked;
    if (approve) {
      for (const sibHash of siblings) {
        const sib = this.ledger.allBlocks.get(sibHash);
        if (!sib) continue;
        if (sib.timestamp < block.timestamp || (sib.timestamp === block.timestamp && sibHash < block.hash)) {
          approve = false;
          break;
        }
      }
    }
    for (const [pub, keys] of this.localKeys) {
      const balance = this.ledger.getAccountBalance(pub);
      if (balance <= 0) continue;
      const head = this.ledger.getAccountHead(pub);
      const vote = await VoteManager.createVote(block.hash, approve, balance, keys, head?.hash);
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
          this.ledger.registerAccount({
            username: String(accData.username), pub: String(accData.pub || accountPub),
            balance: Number(accData.balance || 0), nonce: Number(accData.nonce || 0),
            createdAt: Number(accData.createdAt || 0), faceMapHash: String(accData.faceMapHash || ''),
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

    // Build a GossipSubAdapter so WebRTC ICE signaling routes through the existing
    // GossipSub mesh instead of the relay WebSocket, removing the hub as a SPOF.
    const pubsub = this.net.libp2p.services.pubsub as unknown as {
      publish(topic: string, data: Uint8Array): Promise<void>;
      subscribe(topic: string): void;
      addEventListener(event: string, handler: EventListener): void;
      removeEventListener(event: string, handler: EventListener): void;
    };
    const gsAdapter: GossipSubAdapter = {
      peerId: this.net.libp2p.peerId.toString(),
      networkId: this.ledger.network,
      publish: (topic, data) => { pubsub.publish(topic, data).catch(() => {}); },
      subscribe: (topic) => pubsub.subscribe(topic),
      addEventListener: (evt, cb) => pubsub.addEventListener(evt, cb),
      removeEventListener: (evt, cb) => pubsub.removeEventListener(evt, cb),
    };

    await this.store.start(gsAdapter);
    // Push our smoke address (now the libp2p peer ID) into peer-addrs broadcasts
    // so every peer can reach us for content retrieval.
    this.store.getSmokeHostname().then(addr => { if (addr) this.net.setSmokeAddr(addr); });
    await this.storage.start();
    this.wireEvents();

    const [chains, accounts, contracts] = await Promise.all([
      this.net.loadAccountChains(),
      this.net.loadAccounts(),
      this.net.loadContracts(),
    ]);

    for (const [pub, accData] of accounts) {
      this.ledger.registerAccount({
        username: String(accData.username || ''), pub: String(accData.pub || pub),
        balance: Number(accData.balance || 0), nonce: Number(accData.nonce || 0),
        createdAt: Number(accData.createdAt || 0), faceMapHash: String(accData.faceMapHash || ''),
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
    // A7: faceAccountCount is maintained incrementally by addBlock - no rebuild needed

    // Seed peer fallbacks from heartbeat-recorded smoke addresses. Providers that have
    // been online recently will have their current (or last known) smoke address on-chain.
    for (const provider of this.ledger.getStorageProviders()) {
      if (provider.smokeAddr) this.store.addPeerFallback(provider.smokeAddr);
    }

    for (const [id, cData] of contracts) {
      if (!this.ledger.contracts.has(id)) {
        this.ledger.contracts.set(id, {
          owner: String(cData.owner || ''), code: String(cData.code || ''),
          state: {}, name: String(cData.name || ''), deployedAt: Number(cData.deployedAt || 0),
        });
      }
    }

    // P4/A5: record watermarks after startup load so resyncFromNet only reads new writes
    this.lastSyncedAccountVersion = this.net.getAccountVersionCounter();
    this.lastSyncedBlockVersion = this.net.getBlockVersionCounter();

    this.voteProcessInterval = setInterval(() => this.ledger.processConflicts(), 3000);
    this.resyncInterval = setInterval(() => this.resyncFromNet(), 60_000);
    this.relayLivenessInterval = setInterval(() => this.checkRelayLiveness(), 5 * 60 * 1000);
    // Re-publish every 20s: incremental (new blocks only) to avoid flooding the mesh
    this.publishInterval = setInterval(() => {
      this.publishLocalData(false);
      this.sweepUnclaimedReceives();
      this.maybeCreateSnapshot().catch(console.error);
    }, 20_000);

    // Publish local state once on startup so any already-connected peers receive it
    setTimeout(() => this.publishLocalData(), 3000);
    // Sweep for any unclaimed sends that arrived before keys were loaded
    setTimeout(() => this.sweepUnclaimedReceives(), 4000);
    // P7: dial known peers that were discovered in previous sessions
    setTimeout(() => this.connectToKnownPeers(), 5000);

    this.status = 'running';
    this.startTime = Date.now();
    this.emit('node:started');
  }

  private async resyncFromNet(): Promise<void> {
    // P7: skip IDB resync if no network activity has dirtied any accounts since last run
    if (this.dirtyAccounts.size === 0) return;
    this.dirtyAccounts.clear();
    try {
      // P4: only read accounts written to IDB after the last resync (O(changed) vs O(total))
      const accounts = await this.net.loadChangedAccounts(this.lastSyncedAccountVersion);
      let newAccounts = 0;
      for (const [pub, accData] of accounts) {
        if (!accData.username) continue;
        if (accData._sig) {
          const valid = await NeuronNode.verifyAccountData(accData);
          if (!valid) continue;
        }
        const existing = this.ledger.accounts.has(pub);
        this.ledger.registerAccount({
          username: String(accData.username), pub: String(accData.pub || pub),
          balance: Number(accData.balance || 0), nonce: Number(accData.nonce || 0),
          createdAt: Number(accData.createdAt || 0), faceMapHash: String(accData.faceMapHash || ''),
          linkedAnchor: accData.linkedAnchor ? String(accData.linkedAnchor) : undefined,
          pqPub: accData.pqPub ? String(accData.pqPub) : undefined,
          pqKemPub: accData.pqKemPub ? String(accData.pqKemPub) : undefined,
          pinSalt: accData.pinSalt ? String(accData.pinSalt) : undefined,
          pinVerifier: accData.pinVerifier ? String(accData.pinVerifier) : undefined,
        });
        if (!existing) newAccounts++;
      }

      // A5: only read blocks written to IDB after the last resync - O(new) instead of O(all)
      const newBlockList = await this.net.loadBlocksSince(this.lastSyncedBlockVersion);
      let newBlocks = 0;
      for (const block of newBlockList) {
        if (!this.ledger.accounts.has(block.accountPub)) {
          this.ledger.registerAccount({ username: block.accountPub.slice(0, 16), pub: block.accountPub, balance: 0, nonce: 0, createdAt: Date.now(), faceMapHash: '' });
        }
        if (!this.ledger.allBlocks.has(block.hash)) {
          const result = await this.ledger.addBlock(block);
          if (result.success) { newBlocks++; this.voteIfConflict(block); this.autoReceive(block); }
        }
      }
      // P4/A5: advance watermarks so the next resync only reads newer writes
      this.lastSyncedAccountVersion = this.net.getAccountVersionCounter();
      this.lastSyncedBlockVersion = this.net.getBlockVersionCounter();

      // A7: faceAccountCount is maintained incrementally in addBlock - no rebuild needed
      if (newAccounts > 0 || newBlocks > 0) {
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

  /**
   * Broadcast local state to peers.
   * full=true  → send all blocks (used on peer:connected and startup)
   * full=false → send only blocks with timestamp >= lastPublishedAt (periodic 20s tick)
   *
   * Accounts are always re-published (small overhead, needed for peer discovery).
   * Key blobs are NOT re-gossiped here - they are published once on save via saveKeyBlob.
   */
  async publishLocalData(full = true): Promise<void> {
    this.net.publishGeneration();

    for (const [pub, acc] of this.ledger.accounts) {
      const keys = this.localKeys.get(pub);
      const accData: Record<string, unknown> = {
        username: acc.username, pub: acc.pub, balance: acc.balance, nonce: acc.nonce,
        createdAt: acc.createdAt, faceMapHash: acc.faceMapHash,
        linkedAnchor: acc.linkedAnchor ?? undefined,
        pqPub: acc.pqPub ?? undefined,
        pqKemPub: acc.pqKemPub ?? undefined,
        pinSalt: acc.pinSalt ?? undefined,
        pinVerifier: acc.pinVerifier ?? undefined,
      };
      this.net.saveAccount(pub, keys ? await this.signAccountData(accData, keys) : accData);
    }

    // P1/A3: incremental publish - only iterate blocks since the last publish
    const blocks = full
      ? Array.from(this.ledger.allBlocks.values())
      : this.ledger.getBlocksSince(this.lastPublishedAt - 5_000);
    for (const block of blocks) this.net.publishBlock(block);
    this.lastPublishedAt = Date.now();
  }

  async stop(): Promise<void> {
    this.stopValidating();
    if (this.voteProcessInterval) { clearInterval(this.voteProcessInterval); this.voteProcessInterval = null; }
    if (this.resyncInterval) { clearInterval(this.resyncInterval); this.resyncInterval = null; }
    if (this.publishInterval) { clearInterval(this.publishInterval); this.publishInterval = null; }
    if (this.relayLivenessInterval) { clearInterval(this.relayLivenessInterval); this.relayLivenessInterval = null; }
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

  // ── A8: Epoch snapshots ───────────────────────────────────────────────────

  /**
   * If the estimated blockchain size has grown by >= 1 GB since the last snapshot,
   * create a compressed snapshot, pin it in the SmokeStore, and broadcast the CID
   * to the gossip network so new nodes can bootstrap from it.
   */
  async maybeCreateSnapshot(): Promise<void> {
    if (this.snapshotPending) return;
    const currentBytes = this.ledger.estimateBlockchainSizeBytes();
    if (currentBytes - this.lastSnapshotBytes < SNAPSHOT_TRIGGER_BYTES) return;

    this.snapshotPending = true;
    try {
      const accounts = Array.from(this.ledger.accounts.values());
      const blocks = Array.from(this.ledger.allBlocks.values());
      const head = blocks.reduce((best, b) => (!best || b.timestamp > best.timestamp) ? b : best, blocks[0] as AccountBlock | undefined);
      const epochBlock = head?.hash ?? '0'.repeat(64);

      const data = await createSnapshot(this.ledger.network, accounts, blocks, epochBlock);
      const cid = await this.store.store(data);

      this.net.publishSnapshot(cid, data.byteLength, epochBlock);
      this.lastSnapshotBytes = currentBytes;
      this.emit('snapshot:created', { cid, bytes: data.byteLength });
    } catch (err) {
      console.error('[Snapshot] creation failed:', err);
    } finally {
      this.snapshotPending = false;
    }
  }

  /**
   * Apply an incoming snapshot to the ledger. Only applied if the ledger is empty
   * (bootstrap case) to avoid overwriting existing state.
   */
  async applySnapshot(data: Uint8Array): Promise<boolean> {
    if (this.ledger.allBlocks.size > 0) return false;

    const snap = await parseSnapshot(data);
    if (!snap || snap.network !== this.ledger.network) return false;

    for (const acc of snap.accounts) this.ledger.registerAccount(acc);
    for (const block of snap.blocks) await this.ledger.addBlock(block);

    this.lastSnapshotBytes = this.ledger.estimateBlockchainSizeBytes();
    this.emit('snapshot:applied', { epochBlock: snap.epochBlock, blocks: snap.blocks.length });
    return true;
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
    const submitResult = await this.submitBlock(result.block);
    if (submitResult.success) {
      // Send an immediate heartbeat so score and actualStoredBytes are initialised
      // right away rather than waiting for the ~4-hour scheduled interval.
      setTimeout(() => this.storage.broadcastHeartbeat(pub, keys), 1500);
    }
    return submitResult;
  }

  /**
   * Re-publish all local blocks to connected peers so they respond with their own
   * blocks. Use this when provider stats look stale — a peer may have sent its
   * storage-register block before this node joined the GossipSub mesh.
   */
  async broadcastLocalState(): Promise<void> {
    await this.publishLocalData(false);  // full (non-incremental) publish triggers peer replies
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

  /**
   * Replace content: delete old CIDs locally, broadcast a signed ReplaceRequest
   * so every network provider swaps old→new, then distribute the new CIDs.
   * Pass all related CIDs (meta + inner content) for both old and new versions.
   */
  async replaceContent(
    oldCids: string[],
    newCids: string[],
    ownerPub: string,
    keys: KeyPair,
  ): Promise<{ providers: string[]; error?: string }> {
    for (const cid of oldCids) {
      await this.store.deleteBlock(cid);
    }
    return this.storage.replaceContent(
      oldCids[0], newCids[0], ownerPub, keys,
      oldCids.slice(1), newCids.slice(1),
    );
  }

  // ── Community relay registry ──────────────────────────────────────────────

  async announceRelay(addr: string, keys: KeyPair): Promise<void> {
    await this.net.publishRelayAnnouncement(addr, keys);
  }

  getKnownRelays() {
    return this.net.getKnownRelays();
  }

  private async checkRelayLiveness(): Promise<void> {
    if (this.status === 'stopped') return;
    const connected = new Set(
      (this.net.libp2p?.getConnections?.() ?? []).map(c => c.remotePeer.toString())
    );
    for (const r of this.net.getKnownRelays()) {
      if (connected.has(r.peerId)) {
        // Still connected — refresh lastSeen
        await this.net.upsertKnownRelay(r.addr, r.announcerPub);
      } else {
        try {
          await this.net.libp2p.dial(multiaddr(r.addr));
          await this.net.upsertKnownRelay(r.addr, r.announcerPub);
        } catch {
          await this.net.markRelayFailed(r.addr);
        }
      }
    }
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
