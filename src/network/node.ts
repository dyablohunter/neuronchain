import { DAGLedger, NetworkType } from '../core/dag-ledger';
import { GunNetwork } from './gun-network';
import { AccountBlock } from '../core/dag-block';
import { VoteManager, Vote } from '../core/vote';
import { KeyPair } from '../core/crypto';
import { EventEmitter } from '../core/events';

export interface NodeStats {
  status: 'stopped' | 'running' | 'validating';
  uptime: number;
  network: NetworkType;
  peerId: string;
  peerCount: number;
  shards: number;
}

export class NeuronNode extends EventEmitter {
  ledger: DAGLedger;
  gunNet: GunNetwork;
  private status: 'stopped' | 'running' | 'validating' = 'stopped';
  private startTime: number | null = null;
  private voteProcessInterval: ReturnType<typeof setInterval> | null = null;
  private resyncInterval: ReturnType<typeof setInterval> | null = null;

  /** Keys of locally owned accounts — used for auto-voting and auto-receiving */
  localKeys: Map<string, KeyPair> = new Map();

  constructor(network: NetworkType = 'testnet') {
    super();
    this.ledger = new DAGLedger(network);
    this.gunNet = new GunNetwork(network);
  }

  private wireEvents(): void {
    // Accounts synced from peers — register locally if new
    this.gunNet.on('account:synced', (data: unknown) => {
      const acc = data as Record<string, unknown>;
      const pub = String(acc.pub);
      if (!this.ledger.accounts.has(pub)) {
        this.ledger.registerAccount({
          username: String(acc.username),
          pub,
          balance: Number(acc.balance || 0),
          nonce: Number(acc.nonce || 0),
          createdAt: Number(acc.createdAt || 0),
          faceMapHash: String(acc.faceMapHash || ''),
        });
        this.emit('account:synced', acc);
      }
    });

    // Blocks from peers
    this.gunNet.on('block:received', async (block: unknown) => {
      const b = block as AccountBlock;

      // If this is an open block for an unknown account, register it first
      if (b.type === 'open' && !this.ledger.accounts.has(b.accountPub)) {
        this.ledger.registerAccount({
          username: b.accountPub, // temporary — will be updated by account:synced
          pub: b.accountPub,
          balance: 0,
          nonce: 0,
          createdAt: b.timestamp,
          faceMapHash: b.faceMapHash || '',
        });
      }

      const result = await this.ledger.addBlock(b);
      if (result.success) {
        this.emit('block:received', b);
        this.voteIfConflict(b);
        this.autoReceive(b);
      }
    });

    // Votes from peers
    this.gunNet.on('vote:received', (vote: unknown) => {
      const v = vote as Vote;
      this.ledger.castVote(v);
      this.emit('vote:received', v);
    });

    // Ledger events
    this.ledger.on('block:added', (block: unknown) => this.emit('block:added', block));
    this.ledger.on('block:confirmed', (block: unknown) => this.emit('block:confirmed', block));
    this.ledger.on('block:conflict', (block: unknown) => this.emit('block:conflict', block));
    this.ledger.on('block:rejected', (block: unknown) => this.emit('block:rejected', block));
    this.ledger.on('contract:deployed', (data: unknown) => this.emit('contract:deployed', data));
    this.ledger.on('contract:executed', (data: unknown) => this.emit('contract:executed', data));
    this.ledger.on('contract:error', (data: unknown) => this.emit('contract:error', data));

    this.gunNet.on('peer:connected', (peerId: unknown) => this.emit('peer:connected', peerId));
    this.gunNet.on('peer:disconnected', (peerId: unknown) => this.emit('peer:disconnected', peerId));
  }

  /**
   * Vote on a block — only if it's in conflict (fork detected).
   * Uncontested blocks are confirmed optimistically without voting.
   */
  private async voteIfConflict(block: AccountBlock): Promise<void> {
    const status = this.ledger.votes.getStatus(block.hash);
    if (status !== 'conflict') return; // No conflict — no vote needed

    for (const [pub, keys] of this.localKeys) {
      const balance = this.ledger.getAccountBalance(pub);
      if (balance <= 0) continue;
      const vote = await VoteManager.createVote(block.hash, true, balance, keys);
      this.ledger.castVote(vote);
      this.gunNet.publishVote(vote);
    }
  }

  /** Auto-receive sends addressed to local accounts */
  private async autoReceive(block: AccountBlock): Promise<void> {
    if (block.type !== 'send' || !block.recipient) return;
    const keys = this.localKeys.get(block.recipient);
    if (!keys) return;

    setTimeout(async () => {
      const result = await this.ledger.createReceive(block.recipient!, block.hash, keys);
      if (result.block) {
        await this.ledger.addBlock(result.block);
        this.gunNet.publishBlock(result.block);
        this.emit('auto:received', { from: block.accountPub, amount: block.amount });
      }
    }, 500);
  }

  // ──── Lifecycle ────

  async start(): Promise<void> {
    if (this.status !== 'stopped') return;

    await this.gunNet.start();
    this.wireEvents();

    // Load persisted data
    const chains = await this.gunNet.loadAccountChains();
    const accounts = await this.gunNet.loadAccounts();
    const contracts = await this.gunNet.loadContracts();

    for (const [pub, accData] of accounts) {
      this.ledger.registerAccount({
        username: String(accData.username || ''),
        pub: String(accData.pub || pub),
        balance: Number(accData.balance || 0),
        nonce: Number(accData.nonce || 0),
        createdAt: Number(accData.createdAt || 0),
        faceMapHash: String(accData.faceMapHash || ''),
      });
    }

    for (const [, chain] of chains) {
      for (const block of chain) {
        await this.ledger.addBlock(block);
      }
    }

    for (const [id, cData] of contracts) {
      if (!this.ledger.contracts.has(id)) {
        this.ledger.contracts.set(id, {
          owner: String(cData.owner || ''),
          code: String(cData.code || ''),
          state: {},
          name: String(cData.name || ''),
          deployedAt: Number(cData.deployedAt || 0),
        });
      }
    }

    // Periodic vote processing
    this.voteProcessInterval = setInterval(() => {
      this.ledger.processConflicts();
    }, 3000);

    // Periodic resync from Gun (catches anything the live listeners missed)
    this.resyncInterval = setInterval(() => this.resyncFromGun(), 8000);

    this.status = 'running';
    this.startTime = Date.now();
    this.emit('node:started');
  }

  /** Poll Gun for accounts and blocks we may have missed */
  private async resyncFromGun(): Promise<void> {
    try {
      // Resync accounts first (so blocks can reference them)
      const accounts = await this.gunNet.loadAccounts();
      let newAccounts = 0;
      for (const [pub, accData] of accounts) {
        if (!accData.username) continue; // Skip null/deleted entries
        const existing = this.ledger.accounts.has(pub);
        this.ledger.registerAccount({
          username: String(accData.username),
          pub: String(accData.pub || pub),
          balance: Number(accData.balance || 0),
          nonce: Number(accData.nonce || 0),
          createdAt: Number(accData.createdAt || 0),
          faceMapHash: String(accData.faceMapHash || ''),
        });
        if (!existing) newAccounts++;
      }

      // Resync blocks
      const chains = await this.gunNet.loadAccountChains();
      let newBlocks = 0;
      for (const [accountPub, chain] of chains) {
        // Ensure account exists before adding blocks
        if (!this.ledger.accounts.has(accountPub)) {
          this.ledger.registerAccount({
            username: accountPub.slice(0, 16),
            pub: accountPub,
            balance: 0,
            nonce: 0,
            createdAt: Date.now(),
            faceMapHash: '',
          });
        }

        for (const block of chain) {
          if (!this.ledger.allBlocks.has(block.hash)) {
            const result = await this.ledger.addBlock(block);
            if (result.success) {
              newBlocks++;
              this.voteIfConflict(block);
              this.autoReceive(block);
            } else {
              console.log(`[Resync] Failed to add block ${block.hash.slice(0, 12)}: ${result.error}`);
            }
          }
        }
      }

      if (newAccounts > 0 || newBlocks > 0) {
        console.log(`[Resync] +${newAccounts} accounts, +${newBlocks} blocks`);
        this.emit('resync', { newAccounts, newBlocks });
      }
    } catch (err) {
      console.error('Resync error:', err);
    }
  }

  /** Publish all local accounts and blocks to Gun (call after registering accounts) */
  publishLocalData(): void {
    let published = 0;

    // Publish all accounts
    for (const [pub, acc] of this.ledger.accounts) {
      this.gunNet.saveAccount(pub, {
        username: acc.username,
        pub: acc.pub,
        balance: acc.balance,
        nonce: acc.nonce,
        createdAt: acc.createdAt,
        faceMapHash: acc.faceMapHash,
      });
    }

    // Publish all blocks
    for (const [, block] of this.ledger.allBlocks) {
      this.gunNet.publishBlock(block);
      published++;
    }

    if (published > 0) {
      console.log(`[Node] Published ${this.ledger.accounts.size} accounts and ${published} blocks to Gun`);
    }
  }

  async stop(): Promise<void> {
    this.stopValidating();
    if (this.voteProcessInterval) {
      clearInterval(this.voteProcessInterval);
      this.voteProcessInterval = null;
    }
    if (this.resyncInterval) {
      clearInterval(this.resyncInterval);
      this.resyncInterval = null;
    }
    await this.gunNet.stop();
    this.status = 'stopped';
    this.startTime = null;
    this.emit('node:stopped');
  }

  // ──── Validating (participate in consensus voting) ────

  startValidating(): void {
    if (this.status === 'stopped') return;
    this.status = 'validating';
    this.emit('validating:started');
  }

  stopValidating(): void {
    if (this.status === 'validating') {
      this.status = 'running';
      this.emit('validating:stopped');
    }
  }

  // ──── Public API ────

  async submitBlock(block: AccountBlock): Promise<{ success: boolean; error?: string }> {
    const result = await this.ledger.addBlock(block);
    if (result.success) {
      this.gunNet.publishBlock(block);
      this.voteIfConflict(block);
    }
    return result;
  }

  getStats(): NodeStats {
    const netStats = this.gunNet.getStats();
    return {
      status: this.status,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      network: this.ledger.network,
      peerId: netStats.peerId,
      peerCount: netStats.peerCount,
      shards: netStats.shards,
    };
  }

  async switchNetwork(network: NetworkType): Promise<void> {
    const wasRunning = this.status !== 'stopped';
    if (wasRunning) await this.stop();
    this.ledger = new DAGLedger(network);
    this.gunNet = new GunNetwork(network);
    this.emit('network:switched', network);
  }
}
