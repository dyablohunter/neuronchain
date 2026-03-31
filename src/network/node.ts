import { DAGLedger, NetworkType } from '../core/dag-ledger';
import { GunNetwork } from './gun-network';
import { AccountBlock } from '../core/dag-block';
import { VoteManager, Vote } from '../core/vote';
import { KeyPair, signData, verifySignature } from '../core/crypto';
import { EventEmitter } from '../core/events';

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
  gunNet: GunNetwork;
  private status: 'stopped' | 'running' | 'validating' = 'stopped';
  private startTime: number | null = null;
  private voteProcessInterval: ReturnType<typeof setInterval> | null = null;
  private resyncInterval: ReturnType<typeof setInterval> | null = null;
  private resyncDebounce: ReturnType<typeof setTimeout> | null = null;

  /** Keys of locally owned accounts — used for auto-voting and auto-receiving */
  localKeys: Map<string, KeyPair> = new Map();
  private processedInbox: Set<string> = new Set();
  private watchedInboxes: Set<string> = new Set();
  private static readonly MAX_INBOX = 10000;

  constructor(network: NetworkType = 'testnet') {
    super();
    this.ledger = new DAGLedger(network);
    this.gunNet = new GunNetwork(network);
  }

  private eventsWired = false;

  private wireEvents(): void {
    if (this.eventsWired) return;
    this.eventsWired = true;
    // Accounts synced from peers — register locally if new, verify signature
    this.gunNet.on('account:synced', async (data: unknown) => {
      const acc = data as Record<string, unknown>;
      const pub = String(acc.pub);
      if (this.ledger.accounts.has(pub)) return;

      // If the account has a signature, verify it came from the owner
      if (acc._sig) {
        const valid = await NeuronNode.verifyAccountData(acc);
        if (!valid) {
          console.warn(`[Node] Rejected account ${pub.slice(0, 12)}... — invalid signature`);
          return;
        }
      }

      this.ledger.registerAccount({
        username: String(acc.username),
        pub,
        balance: Number(acc.balance || 0),
        nonce: Number(acc.nonce || 0),
        createdAt: Number(acc.createdAt || 0),
        faceMapHash: String(acc.faceMapHash || ''),
      });
      this.emit('account:synced', acc);
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

    // Start inbox watches for all local keys
    for (const pub of this.localKeys.keys()) {
      this.startInboxWatch(pub);
    }
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

  private startInboxWatch(pub: string): void {
    if (this.watchedInboxes.has(pub)) return;
    this.watchedInboxes.add(pub);
    this.gunNet.watchInbox(pub, (signal) => {
      const key = `${signal.blockHash}:${signal.sender}`;
      if (this.processedInbox.has(key)) return;
      this.processedInbox.add(key);
      if (this.processedInbox.size > NeuronNode.MAX_INBOX) {
        const first = this.processedInbox.values().next().value!;
        this.processedInbox.delete(first);
      }
      console.log(`[Inbox] Signal from ${signal.sender.slice(0, 12)}... block ${signal.blockHash.slice(0, 12)}...`);
      this.emit('inbox:signal', signal);
      if (!this.ledger.allBlocks.has(signal.blockHash)) {
        this.resyncAccount(signal.sender);
      }
    });
  }

  /** Fast targeted resync — fetch only one account's data from Gun */
  private async resyncAccount(accountPub: string): Promise<void> {
    try {
      // Ensure account exists locally
      if (!this.ledger.accounts.has(accountPub)) {
        const accData = await this.gunNet.loadAccount(accountPub);
        if (accData && accData.username) {
          // Verify signature if present
          if (accData._sig) {
            const valid = await NeuronNode.verifyAccountData(accData);
            if (!valid) {
              console.warn(`[Resync] Rejected account ${accountPub.slice(0, 12)}... — invalid signature`);
              return;
            }
          }
          let faceDescriptor: number[] | undefined;
          if (accData.faceDescriptor) {
            try { faceDescriptor = JSON.parse(String(accData.faceDescriptor)); } catch { /* ignore */ }
          }
          this.ledger.registerAccount({
            username: String(accData.username),
            pub: String(accData.pub || accountPub),
            balance: Number(accData.balance || 0),
            nonce: Number(accData.nonce || 0),
            createdAt: Number(accData.createdAt || 0),
            faceMapHash: String(accData.faceMapHash || ''),
            faceDescriptor,
          });
        }
      }

      // Fetch just this account's chain
      const blocks = await this.gunNet.loadAccountChain(accountPub);
      let newBlocks = 0;
      for (const block of blocks) {
        if (!this.ledger.allBlocks.has(block.hash)) {
          const result = await this.ledger.addBlock(block);
          if (result.success) {
            newBlocks++;
            this.voteIfConflict(block);
            this.autoReceive(block);
          }
        }
      }
      if (newBlocks > 0) {
        console.log(`[Inbox resync] +${newBlocks} blocks for ${accountPub.slice(0, 12)}...`);
        this.emit('resync', { newAccounts: 0, newBlocks });
      }
    } catch (err) {
      console.error('[Inbox resync] error:', err);
    }
  }

  /** Register a local key and start watching its inbox if the node is running */
  addLocalKey(pub: string, keys: KeyPair): void {
    this.localKeys.set(pub, keys);
    if (this.status !== 'stopped') {
      this.startInboxWatch(pub);
    }
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
      let faceDescriptor: number[] | undefined;
      if (accData.faceDescriptor) {
        try { faceDescriptor = JSON.parse(String(accData.faceDescriptor)); } catch { /* ignore */ }
      }
      this.ledger.registerAccount({
        username: String(accData.username || ''),
        pub: String(accData.pub || pub),
        balance: Number(accData.balance || 0),
        nonce: Number(accData.nonce || 0),
        createdAt: Number(accData.createdAt || 0),
        faceMapHash: String(accData.faceMapHash || ''),
        faceDescriptor,
      });
    }

    for (const [, chain] of chains) {
      for (const block of chain) {
        await this.ledger.addBlock(block);
      }
    }

    // Rebuild face account count from loaded blocks
    this.ledger.rebuildFaceAccountCount();

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

    // Background resync — infrequent, just a safety net for missed events
    this.resyncInterval = setInterval(() => this.resyncFromGun(), 60000);

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
        // Verify signature if present — reject spoofed accounts
        if (accData._sig) {
          const valid = await NeuronNode.verifyAccountData(accData);
          if (!valid) {
            console.warn(`[Resync] Rejected account ${pub.slice(0, 12)}... — invalid signature`);
            continue;
          }
        }
        const existing = this.ledger.accounts.has(pub);
        let faceDescriptor: number[] | undefined;
        if (accData.faceDescriptor) {
          try { faceDescriptor = JSON.parse(String(accData.faceDescriptor)); } catch { /* ignore */ }
        }
        this.ledger.registerAccount({
          username: String(accData.username),
          pub: String(accData.pub || pub),
          balance: Number(accData.balance || 0),
          nonce: Number(accData.nonce || 0),
          createdAt: Number(accData.createdAt || 0),
          faceMapHash: String(accData.faceMapHash || ''),
          faceDescriptor,
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
        this.ledger.rebuildFaceAccountCount();
        console.log(`[Resync] +${newAccounts} accounts, +${newBlocks} blocks`);
        this.emit('resync', { newAccounts, newBlocks });
      }
    } catch (err) {
      console.error('Resync error:', err);
    }
  }

  /** On-demand resync — debounced so rapid calls don't spam Gun */
  requestResync(): void {
    if (this.status === 'stopped') return;
    if (this.resyncDebounce) clearTimeout(this.resyncDebounce);
    this.resyncDebounce = setTimeout(() => {
      this.resyncDebounce = null;
      this.resyncFromGun();
    }, 500);
  }

  /** Sign account data so peers can verify authenticity */
  private async signAccountData(acc: Record<string, unknown>, keys: KeyPair): Promise<Record<string, unknown>> {
    const payload = `account:${acc.pub}:${acc.username}:${acc.createdAt}:${acc.faceMapHash}`;
    const signature = await signData(payload, keys);
    return { ...acc, _sig: signature };
  }

  /** Verify that account data was signed by the claimed pub key owner */
  private static async verifyAccountData(acc: Record<string, unknown>): Promise<boolean> {
    if (!acc._sig || !acc.pub) return false;
    const payload = `account:${acc.pub}:${acc.username}:${acc.createdAt}:${acc.faceMapHash}`;
    const result = await verifySignature(String(acc._sig), String(acc.pub));
    return result === payload;
  }

  /** Publish all local accounts and blocks to Gun (call after registering accounts) */
  async publishLocalData(): Promise<void> {
    let published = 0;

    // Publish all accounts (signed with owner's keys)
    for (const [pub, acc] of this.ledger.accounts) {
      const keys = this.localKeys.get(pub);
      const accData: Record<string, unknown> = {
        username: acc.username,
        pub: acc.pub,
        balance: acc.balance,
        nonce: acc.nonce,
        createdAt: acc.createdAt,
        faceMapHash: acc.faceMapHash,
        faceDescriptor: acc.faceDescriptor ? JSON.stringify(acc.faceDescriptor) : undefined,
      };
      if (keys) {
        this.gunNet.saveAccount(pub, await this.signAccountData(accData, keys));
      } else {
        this.gunNet.saveAccount(pub, accData);
      }
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
    if (this.resyncDebounce) {
      clearTimeout(this.resyncDebounce);
      this.resyncDebounce = null;
    }
    await this.gunNet.stop();
    this.gunNet.removeAllListeners();
    this.ledger.removeAllListeners();
    this.eventsWired = false;
    this.processedInbox.clear();
    this.watchedInboxes.clear();
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
      if (block.type === 'send' && block.recipient) {
        this.gunNet.publishInboxSignal(block.recipient, block.accountPub, block.hash, block.amount ?? 0);
      }
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
      synapses: netStats.synapses,
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
