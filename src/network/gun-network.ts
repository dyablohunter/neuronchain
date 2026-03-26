import Gun from 'gun';
import 'gun/sea.js';
import { EventEmitter } from '../core/events';
import { AccountBlock } from '../core/dag-block';
import { Vote } from '../core/vote';

export const NUM_SHARDS = 4;

export interface NetworkStats {
  peerId: string;
  peerCount: number;
  isRunning: boolean;
  shards: number;
  startedAt: number | null;
}

/**
 * Determine which shard an account belongs to.
 */
export function getShardIndex(accountPub: string): number {
  let hash = 0;
  for (let i = 0; i < accountPub.length; i++) {
    hash = ((hash << 5) - hash + accountPub.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % NUM_SHARDS;
}

function getRelayUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:5173/gun';
  return `${window.location.origin}/gun`;
}

/**
 * Gun.js P2P network — single connection, internally sharded.
 *
 * One Gun instance connects to one relay. Data is sharded by
 * splitting the Gun graph into shard paths:
 *
 * neuronchain/{network}/accounts/{pub}             — account metadata (flat, proven to sync)
 * neuronchain/{network}/votes/...                  — conflict votes
 * neuronchain/{network}/peers/...                  — peer presence
 * neuronchain/{network}/keyblobs/{pub}             — encrypted key blobs
 * neuronchain/{network}/contracts/{id}             — contracts
 * neuronchain/{network}/shard-0/dag/{pub}/{idx}    — blocks for shard 0
 * neuronchain/{network}/shard-1/dag/{pub}/{idx}    — blocks for shard 1
 * ...
 *
 * This gives the same logical sharding without multiple WebSocket connections.
 */
export class GunNetwork extends EventEmitter {
  private gun!: ReturnType<typeof Gun>;
  private root!: ReturnType<ReturnType<typeof Gun>['get']>;
  private globalDb!: ReturnType<ReturnType<typeof Gun>['get']>;
  private shardDbs: ReturnType<ReturnType<typeof Gun>['get']>[] = [];

  private network: string;
  private running = false;
  private startedAt: number | null = null;
  private peerId: string;
  private trackedPeers: Map<string, { id: string; lastSeen: number }> = new Map();
  private processedBlocks: Set<string> = new Set();
  private processedVotes: Set<string> = new Set();

  constructor(network: string) {
    super();
    this.network = network;
    this.peerId = this.generatePeerId();
  }

  private generatePeerId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  private getShardDb(accountPub: string) {
    return this.shardDbs[getShardIndex(accountPub)];
  }

  async start(): Promise<void> {
    if (this.running) return;

    const relayUrl = getRelayUrl();
    console.log(`[GunNet] Connecting to ${relayUrl} (${NUM_SHARDS} internal shards)`);

    this.gun = Gun({
      peers: [relayUrl],
      localStorage: false,
      radisk: false,
      file: false,
    });

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

    this.root = this.gun.get(`neuronchain/${this.network}`);
    this.globalDb = this.root; // accounts/votes/peers at top level (proven to sync)

    for (let i = 0; i < NUM_SHARDS; i++) {
      this.shardDbs.push(this.root.get(`shard-${i}`));
    }

    // Live listeners — global (accounts, votes)
    this.globalDb.get('accounts').map().on((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const acc = data as Record<string, unknown>;
      if (acc.pub && acc.username) this.emit('account:synced', acc);
    });

    this.globalDb.get('votes').map().map().on((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const vote = data as Vote;
      const voteKey = `${vote.blockHash}:${vote.voterPub}`;
      if (vote.blockHash && vote.voterPub && !this.processedVotes.has(voteKey)) {
        this.processedVotes.add(voteKey);
        this.emit('vote:received', vote);
      }
    });

    // Live listeners — each shard (blocks)
    for (let i = 0; i < NUM_SHARDS; i++) {
      this.shardDbs[i].get('dag').map().map().on((data: unknown) => {
        if (!data || typeof data !== 'object') return;
        const block = this.deserializeBlock(data as Record<string, unknown>);
        if (block && !this.processedBlocks.has(block.hash)) {
          this.processedBlocks.add(block.hash);
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

    setInterval(() => {
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
    this.trackedPeers.clear();
    this.emit('network:stopped');
  }

  // ──── Publishing ────

  publishBlock(block: AccountBlock): void {
    if (!this.running) return;
    this.processedBlocks.add(block.hash);
    const shardDb = this.getShardDb(block.accountPub);
    const shardIdx = getShardIndex(block.accountPub);
    console.log(`[GunNet] Publishing block to shard ${shardIdx}: ${block.type} by ${block.accountPub.slice(0, 12)}...`);
    shardDb.get('dag').get(block.accountPub).get(String(block.index)).put(this.serializeBlock(block));
  }

  publishVote(vote: Vote): void {
    if (!this.running) return;
    const voteKey = `${vote.blockHash}:${vote.voterPub}`;
    this.processedVotes.add(voteKey);
    this.globalDb.get('votes').get(vote.blockHash).get(vote.voterPub).put({
      blockHash: vote.blockHash, voterPub: vote.voterPub,
      approve: vote.approve, stake: vote.stake,
      timestamp: vote.timestamp, signature: vote.signature,
    });
  }

  saveAccount(pub: string, account: Record<string, unknown>): void {
    if (!this.running || !this.globalDb) return;
    console.log(`[GunNet] Saving account: ${account.username} (shard ${getShardIndex(pub)})`);
    this.globalDb.get('accounts').get(pub).put(account);
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

    // Load from all shards sequentially (same Gun connection)
    for (let shardIdx = 0; shardIdx < NUM_SHARDS; shardIdx++) {
      const pubs = await new Promise<string[]>((resolve) => {
        const list: string[] = [];
        this.shardDbs[shardIdx].get('dag').map().once((data: unknown, key: string) => {
          if (data && key) list.push(key);
        });
        setTimeout(() => resolve(list), 2000);
      });

      for (const pub of pubs) {
        const blocks = await new Promise<AccountBlock[]>((resolve) => {
          const list: AccountBlock[] = [];
          this.shardDbs[shardIdx].get('dag').get(pub).map().once((data: unknown) => {
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
          console.log(`[GunNet] Shard ${shardIdx}: ${blocks.length} blocks for ${pub.slice(0, 12)}...`);
          chains.set(pub, blocks);
        }
      }
    }

    console.log(`[GunNet] Loaded ${chains.size} chains from ${NUM_SHARDS} shards`);
    return chains;
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

  async clearAll(): Promise<void> {
    if (!this.globalDb) return;

    // Clear global
    for (const store of ['accounts', 'votes', 'contracts', 'keyblobs', 'peers']) {
      this.globalDb.get(store).map().once((_: unknown, key: string) => {
        this.globalDb.get(store).get(key).put(null);
        this.globalDb.get(store).get(key).map().once((__: unknown, k2: string) => {
          this.globalDb.get(store).get(key).get(k2).put(null);
        });
      });
    }

    // Clear all shards
    for (const shardDb of this.shardDbs) {
      shardDb.get('dag').map().once((_: unknown, key: string) => {
        shardDb.get('dag').get(key).map().once((__: unknown, k2: string) => {
          shardDb.get('dag').get(key).get(k2).put(null);
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

  private deserializeBlock(data: Record<string, unknown>): AccountBlock | null {
    try {
      if (!data.hash || !data.accountPub) return null;
      return {
        hash: String(data.hash), accountPub: String(data.accountPub),
        index: Number(data.index), type: String(data.type) as AccountBlock['type'],
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
      isRunning: this.running, shards: NUM_SHARDS, startedAt: this.startedAt,
    };
  }

  isRunning(): boolean { return this.running; }
}
