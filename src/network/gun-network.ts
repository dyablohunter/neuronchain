import Gun from 'gun';
import 'gun/sea.js';
import { EventEmitter } from '../core/events';
import { AccountBlock } from '../core/dag-block';
import { Vote } from '../core/vote';

export interface NetworkStats {
  peerId: string;
  peerCount: number;
  isRunning: boolean;
  relays: string[];
  startedAt: number | null;
}

/**
 * Gun relay runs on the same server as Vite at the /gun path.
 * Same port, same protocol, no mixed content, no extra certs.
 *
 * For dev: `npm run dev` → http://localhost:5173
 * For mobile camera: use a tunnel (npx localtunnel, ngrok) for HTTPS
 */
function getRelayUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:5173/gun';
  return `${window.location.origin}/gun`;
}
const DEFAULT_RELAYS: string[] = [getRelayUrl()];

/**
 * Gun.js P2P network layer for block-lattice DAG.
 *
 * Data model:
 *   neuronchain/{network}/dag/{accountPub}/{blockIndex} — account blocks
 *   neuronchain/{network}/votes/{blockHash}/{voterPub}  — votes
 *   neuronchain/{network}/accounts/{pub}                — account metadata
 *   neuronchain/{network}/contracts/{id}                — contracts
 *   neuronchain/{network}/peers/{peerId}                — peer presence
 */
export class GunNetwork extends EventEmitter {
  gun!: ReturnType<typeof Gun>;
  db!: ReturnType<ReturnType<typeof Gun>['get']>;
  private network: string;
  private running = false;
  private startedAt: number | null = null;
  private peerId: string;
  private relays: string[];
  private trackedPeers: Map<string, { id: string; lastSeen: number }> = new Map();
  private processedBlocks: Set<string> = new Set();
  private processedVotes: Set<string> = new Set();

  constructor(network: string, relays?: string[]) {
    super();
    this.network = network;
    this.relays = relays || DEFAULT_RELAYS;
    this.peerId = this.generatePeerId();
  }

  private generatePeerId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async start(): Promise<void> {
    if (this.running) return;

    console.log('[GunNet] Starting with relays:', this.relays);

    this.gun = Gun({
      peers: this.relays,
      localStorage: false,  // Don't use localStorage — rely on relay for sync
      radisk: false,         // Disable local disk storage
      file: false,           // No file storage in browser
    });

    // Log relay connection status
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

    this.db = this.gun.get(`neuronchain/${this.network}`);

    // Listen for new blocks across all accounts
    this.db.get('dag').map().map().on((data: unknown, key: string) => {
      if (!data || typeof data !== 'object') return;
      const block = this.deserializeBlock(data as Record<string, unknown>);
      if (block && !this.processedBlocks.has(block.hash)) {
        this.processedBlocks.add(block.hash);
        this.emit('block:received', block);
      }
    });

    // Listen for votes
    this.db.get('votes').map().map().on((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const vote = data as Vote;
      const voteKey = `${vote.blockHash}:${vote.voterPub}`;
      if (vote.blockHash && vote.voterPub && !this.processedVotes.has(voteKey)) {
        this.processedVotes.add(voteKey);
        this.emit('vote:received', vote);
      }
    });

    // Listen for new accounts (live sync)
    this.db.get('accounts').map().on((data: unknown, key: string) => {
      if (!data || typeof data !== 'object') return;
      const acc = data as Record<string, unknown>;
      if (acc.pub && acc.username) {
        this.emit('account:synced', acc);
      }
    });

    // Peer presence
    this.db.get('peers').get(this.peerId).put({
      id: this.peerId,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    });

    this.db.get('peers').map().on((data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const peer = data as { id: string; lastSeen: number };
      if (peer.id && peer.id !== this.peerId && peer.lastSeen > 0) {
        const isNew = !this.trackedPeers.has(peer.id);
        this.trackedPeers.set(peer.id, peer);
        if (isNew) this.emit('peer:connected', peer.id);
      }
    });

    // Heartbeat
    setInterval(() => {
      if (!this.running) return;
      this.db.get('peers').get(this.peerId).put({ lastSeen: Date.now() });
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
    this.db.get('peers').get(this.peerId).put({ lastSeen: 0 });
    this.running = false;
    this.trackedPeers.clear();
    this.emit('network:stopped');
  }

  // ──── Publishing ────

  publishBlock(block: AccountBlock): void {
    if (!this.running) return;
    this.processedBlocks.add(block.hash);
    const serialized = this.serializeBlock(block);
    console.log(`[GunNet] Publishing block: ${block.type} by ${block.accountPub.slice(0, 16)}... hash=${block.hash.slice(0, 12)}`);
    this.db.get('dag').get(block.accountPub).get(String(block.index)).put(serialized);
  }

  publishVote(vote: Vote): void {
    if (!this.running) return;
    const voteKey = `${vote.blockHash}:${vote.voterPub}`;
    this.processedVotes.add(voteKey);
    this.db.get('votes').get(vote.blockHash).get(vote.voterPub).put({
      blockHash: vote.blockHash,
      voterPub: vote.voterPub,
      approve: vote.approve,
      stake: vote.stake,
      timestamp: vote.timestamp,
      signature: vote.signature,
    });
  }

  saveAccount(pub: string, account: Record<string, unknown>): void {
    if (!this.running || !this.db) return;
    console.log(`[GunNet] Saving account: ${account.username} (${pub.toString().slice(0, 16)}...)`);
    this.db.get('accounts').get(pub).put(account);
  }

  saveContract(id: string, contract: Record<string, unknown>): void {
    if (!this.running || !this.db) return;
    this.db.get('contracts').get(id).put(contract);
  }

  /** Store a face-encrypted key blob on-chain (recoverable from any device) */
  saveKeyBlob(pub: string, blob: Record<string, unknown>): void {
    if (!this.running || !this.db) return;
    this.db.get('keyblobs').get(pub).put(blob);
  }

  /** Load a key blob by public key */
  async loadKeyBlob(pub: string): Promise<Record<string, unknown> | null> {
    if (!this.db) return null;
    return new Promise((resolve) => {
      let resolved = false;
      this.db.get('keyblobs').get(pub).once((data: unknown) => {
        if (!resolved) {
          resolved = true;
          resolve(data && typeof data === 'object' ? data as Record<string, unknown> : null);
        }
      });
      setTimeout(() => { if (!resolved) { resolved = true; resolve(null); } }, 2000);
    });
  }

  /** Load a key blob by username (search all blobs) */
  async findKeyBlobByUsername(username: string): Promise<Record<string, unknown> | null> {
    if (!this.db) return null;
    return new Promise((resolve) => {
      let found: Record<string, unknown> | null = null;
      this.db.get('keyblobs').map().once((data: unknown) => {
        if (data && typeof data === 'object') {
          const d = data as Record<string, unknown>;
          if (d.username === username) found = d;
        }
      });
      setTimeout(() => resolve(found), 2000);
    });
  }

  // ──── Loading ────

  /**
   * Load chains by first getting account list, then loading each chain individually.
   * More reliable than nested .map().map() which Gun handles poorly.
   */
  async loadAccountChains(): Promise<Map<string, AccountBlock[]>> {
    // First get all known account pub keys from the dag
    const accountPubs = await new Promise<string[]>((resolve) => {
      const pubs: string[] = [];
      this.db.get('dag').map().once((data: unknown, key: string) => {
        if (data && key) pubs.push(key);
      });
      setTimeout(() => resolve(pubs), 2000);
    });

    console.log(`[GunNet] Found ${accountPubs.length} account chains in DAG`);

    // Now load each account's blocks individually
    const chains = new Map<string, AccountBlock[]>();

    for (const pub of accountPubs) {
      const blocks = await new Promise<AccountBlock[]>((resolve) => {
        const list: AccountBlock[] = [];
        this.db.get('dag').get(pub).map().once((data: unknown, key: string) => {
          if (data && typeof data === 'object') {
            const block = this.deserializeBlock(data as Record<string, unknown>);
            if (block) {
              console.log(`[GunNet] Loaded block: ${pub.slice(0, 12)}... idx=${block.index} type=${block.type}`);
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
        chains.set(pub, blocks);
      }
    }

    console.log(`[GunNet] Loaded ${chains.size} chains with blocks`);
    return chains;
  }

  async loadAccounts(): Promise<Map<string, Record<string, unknown>>> {
    return new Promise((resolve) => {
      const accounts = new Map<string, Record<string, unknown>>();
      console.log('[GunNet] Loading accounts from Gun...');
      this.db.get('accounts').map().once((data: unknown, key: string) => {
        console.log(`[GunNet] loadAccounts got: key=${key.slice(0, 16)}...`, data ? (data as Record<string,unknown>).username : 'null');
        if (data && typeof data === 'object') accounts.set(key, data as Record<string, unknown>);
      });
      setTimeout(() => resolve(accounts), 3000);
    });
  }

  async loadContracts(): Promise<Map<string, Record<string, unknown>>> {
    return new Promise((resolve) => {
      const contracts = new Map<string, Record<string, unknown>>();
      this.db.get('contracts').map().once((data: unknown, key: string) => {
        if (data && typeof data === 'object') contracts.set(key, data as Record<string, unknown>);
      });
      setTimeout(() => resolve(contracts), 3000);
    });
  }

  // ──── Reset ────

  async clearAll(): Promise<void> {
    if (!this.db) return;

    // Null out all Gun nodes
    const stores = ['dag', 'votes', 'accounts', 'contracts', 'keyblobs', 'peers'];
    for (const store of stores) {
      this.db.get(store).map().once((_: unknown, key: string) => {
        this.db.get(store).get(key).put(null);
        // Also null nested maps (dag, votes have 2 levels)
        this.db.get(store).get(key).map().once((__: unknown, k2: string) => {
          this.db.get(store).get(key).get(k2).put(null);
        });
      });
    }

    this.processedBlocks.clear();
    this.processedVotes.clear();

    // Nuke Gun's localStorage cache to prevent stale data from re-syncing
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('gun/') || key.startsWith('gun-'))) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch { /* localStorage access may fail in some contexts */ }

    // Also clear IndexedDB gun storage
    try {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name && (db.name.includes('gun') || db.name.includes('radata'))) {
          indexedDB.deleteDatabase(db.name);
        }
      }
    } catch { /* indexedDB.databases() not available in all browsers */ }
  }

  // ──── Serialization (Gun doesn't support nested arrays) ────

  private serializeBlock(block: AccountBlock): Record<string, unknown> {
    return {
      hash: block.hash,
      accountPub: block.accountPub,
      index: block.index,
      type: block.type,
      previousHash: block.previousHash,
      balance: block.balance,
      timestamp: block.timestamp,
      signature: block.signature,
      recipient: block.recipient || '',
      amount: block.amount ?? 0,
      sendBlockHash: block.sendBlockHash || '',
      sendFrom: block.sendFrom || '',
      receiveAmount: block.receiveAmount ?? 0,
      faceMapHash: block.faceMapHash || '',
      contractData: block.contractData || '',
    };
  }

  private deserializeBlock(data: Record<string, unknown>): AccountBlock | null {
    try {
      if (!data.hash || !data.accountPub) return null;
      return {
        hash: String(data.hash),
        accountPub: String(data.accountPub),
        index: Number(data.index),
        type: String(data.type) as AccountBlock['type'],
        previousHash: String(data.previousHash),
        balance: Number(data.balance),
        timestamp: Number(data.timestamp),
        signature: String(data.signature),
        recipient: data.recipient ? String(data.recipient) : undefined,
        amount: data.amount ? Number(data.amount) : undefined,
        sendBlockHash: data.sendBlockHash ? String(data.sendBlockHash) : undefined,
        sendFrom: data.sendFrom ? String(data.sendFrom) : undefined,
        receiveAmount: data.receiveAmount ? Number(data.receiveAmount) : undefined,
        faceMapHash: data.faceMapHash ? String(data.faceMapHash) : undefined,
        contractData: data.contractData ? String(data.contractData) : undefined,
      };
    } catch {
      return null;
    }
  }

  getStats(): NetworkStats {
    return {
      peerId: this.peerId,
      peerCount: this.trackedPeers.size,
      isRunning: this.running,
      relays: this.relays,
      startedAt: this.startedAt,
    };
  }

  isRunning(): boolean {
    return this.running;
  }
}
