import Gun from 'gun';
import 'gun/sea.js';
import { EventEmitter } from '../core/events';
import { AccountBlock } from '../core/dag-block';
import { Vote } from '../core/vote';
import { verifySignature } from '../core/crypto';

export const NUM_SYNAPSES = 4;

/**
 * Known operator public keys — only these keys can sign mainnet generation bumps.
 * Add operator pub keys here as the network grows. For testnet, this is not enforced.
 * In production, load from a governance config or on-chain registry.
 */
export const KNOWN_OPERATORS: string[] = [
  // Add operator pub keys here, e.g.:
  // 'operator1_pub_key_here',
];

export interface NetworkStats {
  peerId: string;
  peerCount: number;
  isRunning: boolean;
  synapses: number;
  startedAt: number | null;
}

/**
 * Determine which synapse an account belongs to.
 */
export function getSynapseIndex(accountPub: string): number {
  let hash = 0;
  for (let i = 0; i < accountPub.length; i++) {
    hash = ((hash << 5) - hash + accountPub.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % NUM_SYNAPSES;
}

/**
 * Relay URLs — connect to multiple independent relays for decentralization.
 * If one relay censors or goes down, data still propagates through others.
 * Add community-run relays here as the network grows.
 */
function getRelayUrls(): string[] {
  // Check for user-configured relays (set via localStorage or env)
  if (typeof window !== 'undefined') {
    try {
      const custom = localStorage.getItem('neuronchain_relays');
      if (custom) {
        const parsed = JSON.parse(custom) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch { /* ignore */ }
  }

  const origin = typeof window === 'undefined'
    ? 'http://localhost:5173'
    : window.location.origin;

  // Default: origin relay. Add additional relays for redundancy:
  // e.g. ['https://relay1.neuronchain.net/gun', 'https://relay2.neuronchain.net/gun']
  return [`${origin}/gun`];
}

/**
 * Gun.js P2P network — single connection, path-sharded.
 *
 * One Gun instance connects to one relay. Data is split by
 * synapse paths in the Gun graph:
 *
 *   neuronchain/{network}/accounts/{pub}               — account metadata
 *   neuronchain/{network}/votes/...                    — conflict votes
 *   neuronchain/{network}/peers/...                    — peer presence
 *   neuronchain/{network}/keyblobs/{pub}               — encrypted key blobs
 *   neuronchain/{network}/contracts/{id}               — contracts
 *   neuronchain/{network}/synapse-0/dag/{pub}/{idx}    — blocks for synapse 0
 *   neuronchain/{network}/synapse-1/dag/{pub}/{idx}    — blocks for synapse 1
 *   ...
 *
 * The synapse paths map 1:1 to separate relay URLs, so for production
 * scaling you can point each synapse at a different Gun relay server
 * by changing getRelayUrl() to return per-synapse URLs.
 */
/**
 * Gun node reference — Gun's built-in types don't support schemaless/dynamic keys,
 * so we define a minimal interface covering the methods we actually use.
 * This avoids the `never` cascade from ReturnType<...>['get'] through Gun's generics.
 */
interface GunRef {
  get(key: string): GunRef;
  put(value: unknown, cb?: (ack: unknown) => void): GunRef;
  on(cb: (data: unknown, key: string) => void): GunRef;
  once(cb: (data: unknown, key: string) => void): GunRef;
  map(): GunRef;
  off(): GunRef;
  set(value: unknown, cb?: (ack: unknown) => void): GunRef;
}

export class GunNetwork extends EventEmitter {
  private gun!: ReturnType<typeof Gun>;
  private root!: GunRef;
  private globalDb!: GunRef;
  private synapseDbs: GunRef[] = [];

  private network: string;
  private running = false;
  private startedAt: number | null = null;
  private peerId: string;
  private trackedPeers: Map<string, { id: string; lastSeen: number }> = new Map();
  private processedBlocks: Set<string> = new Set();
  private processedVotes: Set<string> = new Set();
  private peerHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly MAX_PROCESSED = 50000;
  /** Generation counter — incremented on reset, data from older generations is ignored */
  private generation = 0;

  constructor(network: string) {
    super();
    this.network = network;
    this.peerId = this.generatePeerId();
    this.loadGeneration();
  }

  private get generationKey(): string {
    return `neuronchain_generation_${this.network}`;
  }

  private loadGeneration(): void {
    try {
      this.generation = parseInt(localStorage.getItem(this.generationKey) || '0', 10) || 0;
    } catch { this.generation = 0; }
  }

  private saveGeneration(): void {
    try { localStorage.setItem(this.generationKey, String(this.generation)); } catch {}
  }

  /** Verify a signed generation bump message from a known operator */
  private async verifyGenerationBump(msg: { generation?: number; signature?: string; operatorPub?: string }): Promise<boolean> {
    if (!msg.signature || !msg.operatorPub || typeof msg.generation !== 'number') return false;
    const payload = `generation:${msg.generation}`;
    const result = await verifySignature(msg.signature, msg.operatorPub);
    return result === payload;
  }

  private generatePeerId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  private getSynapseDb(accountPub: string) {
    return this.synapseDbs[getSynapseIndex(accountPub)];
  }

  async start(): Promise<void> {
    if (this.running) return;

    const relayUrls = getRelayUrls();
    console.log(`[GunNet] Connecting to ${relayUrls.length} relay(s): ${relayUrls.join(', ')} (${NUM_SYNAPSES} synapse paths)`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.gun = Gun({
      peers: relayUrls,
      localStorage: false,
      radisk: false,
      file: false,
    } as any);

    this.gun.on('hi', (peer: unknown) => {
      const p = peer as { url?: string; id?: string };
      console.log('[GunNet] Relay connected:', p.url || p.id || 'unknown');
      this.emit('relay:connected', p.url || p.id);
    });
    this.gun.on('bye', (peer: unknown) => {
      const p = peer as { url?: string; id?: string };
      console.log('[GunNet] Relay disconnected:', p.url || p.id || 'unknown');
      this.emit('relay:disconnected', p.url || p.id);
    });

    this.root = this.gun.get(`neuronchain/${this.network}`) as unknown as GunRef;
    this.globalDb = this.root;

    for (let i = 0; i < NUM_SYNAPSES; i++) {
      this.synapseDbs.push(this.root.get(`synapse-${i}`));
    }

    // Listen for generation updates — require signed governance message
    // On testnet, unsigned bumps are still accepted for convenience.
    // On mainnet, only signed generation bumps from known operators are accepted.
    this.globalDb.get('_generation_msg').on((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const msg = data as { generation?: number; signature?: string; operatorPub?: string };
      if (typeof msg.generation !== 'number' || msg.generation <= this.generation) return;

      if (this.network === 'mainnet') {
        // Mainnet: require signature from a known operator
        if (!msg.signature || !msg.operatorPub || !KNOWN_OPERATORS.includes(msg.operatorPub)) {
          console.warn(`[GunNet] Rejected generation bump — unsigned or unknown operator`);
          return;
        }
        // Signature verification is done asynchronously
        this.verifyGenerationBump(msg).then(valid => {
          if (valid) {
            console.log(`[GunNet] Generation updated (signed): ${this.generation} → ${msg.generation}`);
            this.generation = msg.generation!;
            this.saveGeneration();
          }
        });
      } else {
        // Testnet: accept any bump (backwards compat)
        console.log(`[GunNet] Generation updated: ${this.generation} → ${msg.generation}`);
        this.generation = msg.generation;
        this.saveGeneration();
      }
    });
    // Backwards compat: still listen to raw _generation for testnet
    if (this.network !== 'mainnet') {
      this.globalDb.get('_generation').on((data: unknown) => {
        if (typeof data === 'number' && data > this.generation) {
          console.log(`[GunNet] Generation updated (legacy): ${this.generation} → ${data}`);
          this.generation = data;
          this.saveGeneration();
        }
      });
    }

    // Live listeners — global (accounts, votes)
    // Client-side null-write rejection: ignore data where critical fields are null
    this.globalDb.get('accounts').map().on((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const acc = data as Record<string, unknown>;
      // Reject null writes — critical fields must not be null
      if (acc.pub === null || acc.username === null) return;
      // Reject stale data from before a reset
      if (typeof acc._gen === 'number' && (acc._gen as number) < this.generation) return;
      if (acc.pub && acc.username) this.emit('account:synced', acc);
    });

    this.globalDb.get('votes').map().map().on((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const raw = data as Record<string, unknown>;
      // Reject null writes on vote fields
      if (raw.blockHash === null || raw.voterPub === null || raw.signature === null) return;
      const vote = data as Vote;
      const voteKey = `${vote.blockHash}:${vote.voterPub}`;
      if (vote.blockHash && vote.voterPub && !this.processedVotes.has(voteKey)) {
        this.processedVotes.add(voteKey);
        this.capSet(this.processedVotes);
        this.emit('vote:received', vote);
      }
    });

    // Live listeners — each synapse (blocks)
    // Client-side null-write rejection: ignore blocks with nulled critical fields
    for (let i = 0; i < NUM_SYNAPSES; i++) {
      this.synapseDbs[i].get('dag').map().map().on((data: unknown) => {
        if (!data || typeof data !== 'object') return;
        const raw = data as Record<string, unknown>;
        // Reject null writes — critical block fields must not be null
        if (raw.hash === null || raw.accountPub === null || raw.signature === null) return;
        // Reject data from older generations (stale data after a reset)
        if (typeof raw._gen === 'number' && raw._gen < this.generation) return;
        const block = this.deserializeBlock(raw);
        if (block && !this.processedBlocks.has(block.hash)) {
          this.processedBlocks.add(block.hash);
          this.capSet(this.processedBlocks);
          this.emit('block:received', block);
        }
      });
    }

    // Peer presence
    this.globalDb.get('peers').get(this.peerId).put({
      id: this.peerId, connectedAt: Date.now(), lastSeen: Date.now(),
    });

    this.globalDb.get('peers').map().on((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const peer = data as { id: string; lastSeen: number };
      if (peer.id && peer.id !== this.peerId && peer.lastSeen > 0) {
        const isNew = !this.trackedPeers.has(peer.id);
        this.trackedPeers.set(peer.id, peer);
        if (isNew) this.emit('peer:connected', peer.id);
      }
    });

    this.peerHeartbeatInterval = setInterval(() => {
      if (!this.running) return;
      this.globalDb.get('peers').get(this.peerId).put({ lastSeen: Date.now() });
      const now = Date.now();
      for (const [id, peer] of this.trackedPeers) {
        if (now - peer.lastSeen > 60000) {
          this.trackedPeers.delete(id);
          this.emit('peer:disconnected', id);
        }
      }
    }, 15000);

    this.running = true;
    this.startedAt = Date.now();
    this.emit('network:started', this.peerId);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.globalDb.get('peers').get(this.peerId).put({ lastSeen: 0 });
    this.running = false;
    if (this.peerHeartbeatInterval) {
      clearInterval(this.peerHeartbeatInterval);
      this.peerHeartbeatInterval = null;
    }
    this.trackedPeers.clear();
    this.capSet(this.processedBlocks);
    this.capSet(this.processedVotes);
    this.emit('network:stopped');
  }

  private capSet(set: Set<string>): void {
    if (set.size > GunNetwork.MAX_PROCESSED) {
      const excess = set.size - GunNetwork.MAX_PROCESSED;
      const toDelete: string[] = [];
      let count = 0;
      for (const v of set) {
        if (count < excess) toDelete.push(v);
        else break;
        count++;
      }
      for (const v of toDelete) set.delete(v);
    }
  }

  // ──── Publishing ────

  publishBlock(block: AccountBlock): void {
    if (!this.running) return;
    this.processedBlocks.add(block.hash);
    const synapseDb = this.getSynapseDb(block.accountPub);
    const synapseIdx = getSynapseIndex(block.accountPub);
    console.log(`[GunNet] Publishing block to synapse ${synapseIdx}: ${block.type} by ${block.accountPub.slice(0, 12)}...`);
    const data = this.serializeBlock(block);
    data._gen = this.generation;
    synapseDb.get('dag').get(block.accountPub).get(String(block.index)).put(data);
  }

  publishVote(vote: Vote): void {
    if (!this.running) return;
    const voteKey = `${vote.blockHash}:${vote.voterPub}`;
    this.processedVotes.add(voteKey);
    this.globalDb.get('votes').get(vote.blockHash).get(vote.voterPub).put({
      blockHash: vote.blockHash, voterPub: vote.voterPub,
      approve: vote.approve, stake: vote.stake,
      timestamp: vote.timestamp, signature: vote.signature,
      chainHeadHash: vote.chainHeadHash || '',
    });
  }

  publishInboxSignal(recipientPub: string, senderPub: string, blockHash: string, amount: number, signature?: string): void {
    if (!this.running || !this.globalDb) return;
    const signalId = `${blockHash}:${senderPub}`;
    this.globalDb.get('inbox').get(recipientPub).get(signalId).put({
      sender: senderPub,
      blockHash,
      amount,
      timestamp: Date.now(),
      signature: signature || '',
    });
  }

  watchInbox(recipientPub: string, callback: (signal: { sender: string; blockHash: string; amount: number; timestamp: number; signature?: string }) => void): void {
    if (!this.globalDb) return;
    this.globalDb.get('inbox').get(recipientPub).map().on((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const sig = data as { sender?: string; blockHash?: string; amount?: number; timestamp?: number; signature?: string };
      if (sig.sender && sig.blockHash) {
        callback({ sender: sig.sender, blockHash: sig.blockHash, amount: sig.amount ?? 0, timestamp: sig.timestamp ?? 0, signature: sig.signature });
      }
    });
  }

  saveAccount(pub: string, account: Record<string, unknown>): void {
    if (!this.running || !this.globalDb) return;
    console.log(`[GunNet] Saving account: ${account.username} (synapse ${getSynapseIndex(pub)})`);
    this.globalDb.get('accounts').get(pub).put({ ...account, _gen: this.generation });
  }

  saveContract(id: string, contract: Record<string, unknown>): void {
    if (!this.running || !this.globalDb) return;
    this.globalDb.get('contracts').get(id).put(contract);
  }

  saveKeyBlob(pub: string, blob: Record<string, unknown>): void {
    if (!this.running || !this.globalDb) return;
    this.globalDb.get('keyblobs').get(pub).put(blob);
  }

  async loadKeyBlob(pub: string): Promise<Record<string, unknown> | null> {
    if (!this.globalDb) return null;
    return new Promise((resolve) => {
      let resolved = false;
      this.globalDb.get('keyblobs').get(pub).once((data: unknown) => {
        if (!resolved) { resolved = true; resolve(data && typeof data === 'object' ? data as Record<string, unknown> : null); }
      });
      setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 2000);
    });
  }

  async findKeyBlobByUsername(username: string): Promise<Record<string, unknown> | null> {
    if (!this.globalDb) return null;
    return new Promise((resolve) => {
      let found: Record<string, unknown> | null = null;
      this.globalDb.get('keyblobs').map().once((data: unknown) => {
        if (data && typeof data === 'object') {
          const d = data as Record<string, unknown>;
          if (d.username === username) found = d;
        }
      });
      setTimeout(() => resolve(found), 2000);
    });
  }

  // ──── Loading ────

  async loadAccountChains(): Promise<Map<string, AccountBlock[]>> {
    const chains = new Map<string, AccountBlock[]>();

    for (let synapseIdx = 0; synapseIdx < NUM_SYNAPSES; synapseIdx++) {
      const pubs = await new Promise<string[]>((resolve) => {
        const list: string[] = [];
        this.synapseDbs[synapseIdx].get('dag').map().once((data: unknown, key: string) => {
          if (data && key) list.push(key);
        });
        setTimeout(() => resolve(list), 2000);
      });

      for (const pub of pubs) {
        const blocks = await new Promise<AccountBlock[]>((resolve) => {
          const list: AccountBlock[] = [];
          this.synapseDbs[synapseIdx].get('dag').get(pub).map().once((data: unknown) => {
            if (data && typeof data === 'object') {
              const block = this.deserializeBlock(data as Record<string, unknown>);
              if (block) {
                list.push(block);
                this.processedBlocks.add(block.hash);
              }
            }
          });
          setTimeout(() => {
            list.sort((a, b) => a.index - b.index);
            resolve(list);
          }, 2000);
        });
        if (blocks.length > 0) {
          console.log(`[GunNet] Synapse ${synapseIdx}: ${blocks.length} blocks for ${pub.slice(0, 12)}...`);
          chains.set(pub, blocks);
        }
      }
    }

    console.log(`[GunNet] Loaded ${chains.size} chains from ${NUM_SYNAPSES} synapse paths`);
    return chains;
  }

  async loadAccountChain(accountPub: string): Promise<AccountBlock[]> {
    const synapseDb = this.getSynapseDb(accountPub);
    if (!synapseDb) return [];
    return new Promise((resolve) => {
      const list: AccountBlock[] = [];
      let timer: ReturnType<typeof setTimeout>;
      synapseDb.get('dag').get(accountPub).map().once((data: unknown) => {
        if (data && typeof data === 'object') {
          const block = this.deserializeBlock(data as Record<string, unknown>);
          if (block) {
            list.push(block);
            this.processedBlocks.add(block.hash);
          }
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          list.sort((a, b) => a.index - b.index);
          resolve(list);
        }, 300);
      });
      timer = setTimeout(() => resolve(list), 1500);
    });
  }

  async loadAccount(pub: string): Promise<Record<string, unknown> | null> {
    if (!this.globalDb) return null;
    return new Promise((resolve) => {
      let resolved = false;
      this.globalDb.get('accounts').get(pub).once((data: unknown) => {
        if (!resolved) {
          resolved = true;
          resolve(data && typeof data === 'object' ? data as Record<string, unknown> : null);
        }
      });
      setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 1500);
    });
  }

  async loadAccounts(): Promise<Map<string, Record<string, unknown>>> {
    return new Promise((resolve) => {
      const accounts = new Map<string, Record<string, unknown>>();
      console.log('[GunNet] Loading accounts from global...');
      this.globalDb.get('accounts').map().once((data: unknown, key: string) => {
        if (data && typeof data === 'object') {
          const d = data as Record<string, unknown>;
          if (d.username) accounts.set(key, d);
        }
      });
      setTimeout(() => resolve(accounts), 3000);
    });
  }

  async loadContracts(): Promise<Map<string, Record<string, unknown>>> {
    return new Promise((resolve) => {
      const contracts = new Map<string, Record<string, unknown>>();
      this.globalDb.get('contracts').map().once((data: unknown, key: string) => {
        if (data && typeof data === 'object') contracts.set(key, data as Record<string, unknown>);
      });
      setTimeout(() => resolve(contracts), 3000);
    });
  }

  // ──── Reset ────

  /**
   * Clear all data and increment generation.
   * On mainnet, requires operator keys to sign the generation bump.
   * On testnet, unsigned bumps are allowed for convenience.
   */
  async clearAll(operatorKeys?: { pub: string; priv: string; epub: string; epriv: string }): Promise<void> {
    if (!this.globalDb) return;

    // On mainnet, require operator keys
    if (this.network === 'mainnet' && !operatorKeys) {
      console.error('[GunNet] Mainnet clearAll requires operator keys');
      return;
    }

    // Increment generation — all peers will reject data from older generations
    this.generation++;
    this.saveGeneration();

    // Publish signed generation message for mainnet
    if (operatorKeys) {
      const { signData } = await import('../core/crypto');
      const payload = `generation:${this.generation}`;
      const signature = await signData(payload, operatorKeys);
      this.globalDb.get('_generation_msg').put({
        generation: this.generation,
        signature,
        operatorPub: operatorKeys.pub,
      });
    }
    // Legacy format for testnet backwards compat
    this.globalDb.get('_generation').put(this.generation);
    console.log(`[GunNet] Generation incremented to ${this.generation} — stale data will be rejected`);

    for (const store of ['accounts', 'votes', 'contracts', 'keyblobs', 'peers', 'inbox']) {
      this.globalDb.get(store).map().once((_: unknown, key: string) => {
        this.globalDb.get(store).get(key).put(null);
        this.globalDb.get(store).get(key).map().once((__: unknown, k2: string) => {
          this.globalDb.get(store).get(key).get(k2).put(null);
        });
      });
    }

    for (const synapseDb of this.synapseDbs) {
      synapseDb.get('dag').map().once((_: unknown, key: string) => {
        synapseDb.get('dag').get(key).map().once((__: unknown, k2: string) => {
          synapseDb.get('dag').get(key).get(k2).put(null);
        });
      });
    }

    this.processedBlocks.clear();
    this.processedVotes.clear();

    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('gun/') || key.startsWith('gun-'))) keysToRemove.push(key);
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {}

    try {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name && (db.name.includes('gun') || db.name.includes('radata'))) {
          indexedDB.deleteDatabase(db.name);
        }
      }
    } catch {}
  }

  // ──── Serialization ────

  private serializeBlock(block: AccountBlock): Record<string, unknown> {
    return {
      hash: block.hash, accountPub: block.accountPub, index: block.index,
      type: block.type, previousHash: block.previousHash, balance: block.balance,
      timestamp: block.timestamp, signature: block.signature,
      recipient: block.recipient || '', amount: block.amount ?? 0,
      sendBlockHash: block.sendBlockHash || '', sendFrom: block.sendFrom || '',
      receiveAmount: block.receiveAmount ?? 0, faceMapHash: block.faceMapHash || '',
      contractData: block.contractData || '',
    };
  }

  private static readonly VALID_BLOCK_TYPES = new Set(['open', 'send', 'receive', 'deploy', 'call']);

  private deserializeBlock(data: Record<string, unknown>): AccountBlock | null {
    try {
      if (!data.hash || !data.accountPub) return null;
      const type = String(data.type);
      if (!GunNetwork.VALID_BLOCK_TYPES.has(type)) return null;
      return {
        hash: String(data.hash), accountPub: String(data.accountPub),
        index: Number(data.index), type: type as AccountBlock['type'],
        previousHash: String(data.previousHash), balance: Number(data.balance),
        timestamp: Number(data.timestamp), signature: String(data.signature),
        recipient: data.recipient ? String(data.recipient) : undefined,
        amount: data.amount ? Number(data.amount) : undefined,
        sendBlockHash: data.sendBlockHash ? String(data.sendBlockHash) : undefined,
        sendFrom: data.sendFrom ? String(data.sendFrom) : undefined,
        receiveAmount: data.receiveAmount ? Number(data.receiveAmount) : undefined,
        faceMapHash: data.faceMapHash ? String(data.faceMapHash) : undefined,
        contractData: data.contractData ? String(data.contractData) : undefined,
      };
    } catch { return null; }
  }

  getStats(): NetworkStats {
    return {
      peerId: this.peerId, peerCount: this.trackedPeers.size,
      isRunning: this.running, synapses: NUM_SYNAPSES, startedAt: this.startedAt,
    };
  }

  isRunning(): boolean { return this.running; }
}
