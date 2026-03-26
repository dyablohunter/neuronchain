import {
  AccountBlock,
  AccountBlockType,
  ConfirmedBlock,
  VERIFICATION_MINT_AMOUNT,
  createAccountBlock,
  validateBlockStructure,
  verifyBlockSignature,
} from './dag-block';
import { Account } from './account';
import { KeyPair } from './crypto';
import { VoteManager, Vote } from './vote';
import { EventEmitter } from './events';

export type NetworkType = 'testnet' | 'mainnet';

export interface DAGStats {
  network: NetworkType;
  totalAccounts: number;
  totalBlocks: number;
  pendingBlocks: number;
  confirmedBlocks: number;
  tps: string;
}

/**
 * Block-Lattice DAG Ledger.
 *
 * Each account has its own chain of blocks.
 * Transfers require two blocks: a send block on the sender's chain
 * and a receive block on the recipient's chain.
 * Blocks are confirmed via stake-weighted voting.
 */
export class DAGLedger extends EventEmitter {
  /** Account pub → ordered list of blocks */
  accountChains: Map<string, AccountBlock[]> = new Map();
  /** Block hash → block (all blocks, for quick lookup) */
  allBlocks: Map<string, AccountBlock> = new Map();
  /** Account pub → Account metadata */
  accounts: Map<string, Account> = new Map();
  /** Username → pub key */
  private usernameToPublicKey: Map<string, string> = new Map();
  /** Voting system */
  votes: VoteManager = new VoteManager();
  /** Contracts */
  contracts: Map<string, { owner: string; code: string; state: Record<string, unknown>; name: string; deployedAt: number }> = new Map();
  /** Unclaimed sends: sendBlockHash → { from, to, amount } */
  unclaimedSends: Map<string, { fromPub: string; toPub: string; amount: number }> = new Map();
  /** faceMapHash → number of accounts created with this face */
  faceAccountCount: Map<string, number> = new Map();

  network: NetworkType;
  private txTimestamps: number[] = [];

  constructor(network: NetworkType = 'testnet') {
    super();
    this.network = network;
  }

  // ──── Account management ────

  registerAccount(account: Account): boolean {
    const existing = this.accounts.get(account.pub);
    if (existing) {
      // Update metadata if we have better info (e.g., real username replacing temp pub key)
      if (account.username && account.username !== existing.username && account.username !== account.pub) {
        // Remove old username mapping
        this.usernameToPublicKey.delete(existing.username);
        existing.username = account.username;
        this.usernameToPublicKey.set(account.username, account.pub);
      }
      if (account.faceMapHash && !existing.faceMapHash) {
        existing.faceMapHash = account.faceMapHash;
      }
      return true;
    }
    if (this.usernameToPublicKey.has(account.username) && account.username !== account.pub) return false;
    this.accounts.set(account.pub, { ...account });
    this.usernameToPublicKey.set(account.username, account.pub);
    this.emit('account:created', account);
    return true;
  }

  getAccountByUsername(username: string): Account | undefined {
    const pub = this.usernameToPublicKey.get(username);
    if (!pub) return undefined;
    return this.accounts.get(pub);
  }

  getAccountByPub(pub: string): Account | undefined {
    return this.accounts.get(pub);
  }

  resolveToPublicKey(identifier: string): string | undefined {
    if (this.accounts.has(identifier)) return identifier;
    return this.usernameToPublicKey.get(identifier);
  }

  getAccountBalance(pub: string): number {
    const chain = this.accountChains.get(pub);
    if (!chain || chain.length === 0) return 0;
    return chain[chain.length - 1].balance;
  }

  getAccountHead(pub: string): AccountBlock | null {
    const chain = this.accountChains.get(pub);
    if (!chain || chain.length === 0) return null;
    return chain[chain.length - 1];
  }

  // ──── Block creation (by local user) ────

  /**
   * Max accounts per face: mainnet = 1 (1 human 1 account), testnet = 3.
   */
  getMaxAccountsPerFace(): number {
    return this.network === 'mainnet' ? 1 : 3;
  }

  getFaceAccountCount(faceMapHash: string): number {
    return this.faceAccountCount.get(faceMapHash) || 0;
  }

  /**
   * Create and submit an OPEN block.
   * Requires faceMapHash — FaceID is mandatory for account creation.
   * Enforces per-face account limit (mainnet: 1, testnet: 3).
   * Mints VERIFICATION_MINT_AMOUNT (1,000,000 UNIT) to the new account.
   */
  async openAccount(pub: string, faceMapHash: string, keys: KeyPair): Promise<AccountBlock> {
    const count = this.getFaceAccountCount(faceMapHash);
    const max = this.getMaxAccountsPerFace();
    if (count >= max) {
      throw new Error(`Face already used for ${count} account(s). Limit: ${max} per face on ${this.network}.`);
    }

    const block = await createAccountBlock({
      accountPub: pub,
      index: 0,
      type: 'open',
      previousHash: '0'.repeat(64),
      balance: VERIFICATION_MINT_AMOUNT,
      faceMapHash,
    }, keys);

    await this.addBlock(block);
    return block;
  }

  /**
   * Create a SEND block. Returns the block; call addBlock() to submit.
   */
  async createSend(
    senderPub: string,
    recipientIdentifier: string,
    amount: number,
    keys: KeyPair,
  ): Promise<{ block?: AccountBlock; error?: string }> {
    const recipientPub = this.resolveToPublicKey(recipientIdentifier);
    if (!recipientPub) return { error: 'Recipient not found' };

    const head = this.getAccountHead(senderPub);
    if (!head) return { error: 'Account not opened' };

    if (head.balance < amount) return { error: 'Insufficient balance' };
    if (amount <= 0) return { error: 'Amount must be positive' };

    const block = await createAccountBlock({
      accountPub: senderPub,
      index: head.index + 1,
      type: 'send',
      previousHash: head.hash,
      balance: head.balance - amount,
      recipient: recipientPub,
      amount,
    }, keys);

    return { block };
  }

  /**
   * Create a RECEIVE block for an unclaimed send.
   */
  async createReceive(
    recipientPub: string,
    sendBlockHash: string,
    keys: KeyPair,
  ): Promise<{ block?: AccountBlock; error?: string }> {
    const unclaimed = this.unclaimedSends.get(sendBlockHash);
    if (!unclaimed) return { error: 'Send block not found or already claimed' };
    if (unclaimed.toPub !== recipientPub) return { error: 'This send is not addressed to you' };

    const head = this.getAccountHead(recipientPub);
    if (!head) return { error: 'Account not opened' };

    const block = await createAccountBlock({
      accountPub: recipientPub,
      index: head.index + 1,
      type: 'receive',
      previousHash: head.hash,
      balance: head.balance + unclaimed.amount,
      sendBlockHash,
      sendFrom: unclaimed.fromPub,
      receiveAmount: unclaimed.amount,
    }, keys);

    return { block };
  }

  /**
   * Create a DEPLOY block for a smart contract.
   */
  async createDeploy(
    senderPub: string,
    name: string,
    code: string,
    keys: KeyPair,
  ): Promise<{ block?: AccountBlock; error?: string }> {
    const head = this.getAccountHead(senderPub);
    if (!head) return { error: 'Account not opened' };
    const contractData = JSON.stringify({ name, code });
    const block = await createAccountBlock({
      accountPub: senderPub,
      index: head.index + 1,
      type: 'deploy',
      previousHash: head.hash,
      balance: head.balance,
      contractData,
    }, keys);

    return { block };
  }


  /**
   * Create a CALL block for a smart contract method.
   */
  async createCall(
    senderPub: string,
    contractId: string,
    method: string,
    args: unknown[],
    keys: KeyPair,
  ): Promise<{ block?: AccountBlock; error?: string }> {
    const head = this.getAccountHead(senderPub);
    if (!head) return { error: 'Account not opened' };
    const contractData = JSON.stringify({ contractId, method, args });
    const block = await createAccountBlock({
      accountPub: senderPub,
      index: head.index + 1,
      type: 'call',
      previousHash: head.hash,
      balance: head.balance,
      contractData,
    }, keys);

    return { block };
  }

  // ──── Block submission & validation ────

  /**
   * Add a block to the ledger (from local user or from peer).
   * Validates structure, checks for conflicts, registers for voting.
   */
  async addBlock(block: AccountBlock): Promise<{ success: boolean; error?: string }> {
    // Already have this block?
    if (this.allBlocks.has(block.hash)) return { success: true };

    // Verify signature
    const sigValid = await verifyBlockSignature(block);
    if (!sigValid) return { success: false, error: 'Invalid signature' };

    // Get parent (null for open blocks)
    const parent = block.type === 'open' ? null : this.allBlocks.get(block.previousHash) || null;

    // Validate structure
    const validation = validateBlockStructure(block, parent);
    if (!validation.valid) return { success: false, error: validation.error };

    // For receive blocks: verify the send block exists and is confirmed
    if (block.type === 'receive') {
      const sendBlock = this.allBlocks.get(block.sendBlockHash!);
      if (!sendBlock) return { success: false, error: 'Referenced send block not found' };
      if (sendBlock.type !== 'send') return { success: false, error: 'Referenced block is not a send' };
      if (sendBlock.recipient !== block.accountPub) return { success: false, error: 'Send block recipient mismatch' };
      if (sendBlock.amount !== block.receiveAmount) return { success: false, error: 'Amount mismatch' };
    }

    // Store the block
    this.allBlocks.set(block.hash, block);
    if (!this.accountChains.has(block.accountPub)) {
      this.accountChains.set(block.accountPub, []);
    }
    this.accountChains.get(block.accountPub)!.push(block);

    // Register for voting
    this.votes.registerBlock(block.hash, block.previousHash, block.accountPub);

    // Track unclaimed sends
    if (block.type === 'send' && block.recipient && block.amount) {
      this.unclaimedSends.set(block.hash, {
        fromPub: block.accountPub,
        toPub: block.recipient,
        amount: block.amount,
      });
    }

    // Process receive: remove from unclaimed
    if (block.type === 'receive' && block.sendBlockHash) {
      this.unclaimedSends.delete(block.sendBlockHash);
    }

    // Process contract deploy
    if (block.type === 'deploy' && block.contractData) {
      try {
        const data = JSON.parse(block.contractData);
        this.contracts.set(block.hash, {
          owner: block.accountPub,
          code: data.code,
          state: {},
          name: data.name || 'Unnamed',
          deployedAt: block.timestamp,
        });
        this.emit('contract:deployed', { id: block.hash, name: data.name });
      } catch { /* invalid contract data */ }
    }

    // Process contract call
    if (block.type === 'call' && block.contractData) {
      try {
        const data = JSON.parse(block.contractData);
        this.executeContract(data.contractId, data.method, data.args || [], block.accountPub);
      } catch { /* invalid call data */ }
    }

    // Track face → account count for open blocks
    if (block.type === 'open' && block.faceMapHash) {
      const prev = this.faceAccountCount.get(block.faceMapHash) || 0;
      this.faceAccountCount.set(block.faceMapHash, prev + 1);
    }

    // Update account metadata balance
    const acc = this.accounts.get(block.accountPub);
    if (acc) {
      acc.balance = block.balance;
      acc.nonce = block.index;
    }

    // Register with vote manager — optimistic confirmation or conflict detection
    const result = this.votes.registerBlock(block.hash, block.previousHash, block.accountPub);

    this.txTimestamps.push(Date.now());

    if (result === 'confirmed') {
      this.emit('block:confirmed', block);
    } else {
      this.emit('block:conflict', block);
    }

    this.emit('block:added', block);
    return { success: true };
  }

  // ──── Conflict-Only Voting ────

  /**
   * Cast a vote on a conflicted block.
   * Only matters when two blocks share the same parent (fork).
   */
  castVote(vote: Vote): void {
    this.votes.addVote(vote);
  }

  /**
   * Resolve active conflicts. Called periodically.
   * Only processes blocks that are in conflict (fork detected).
   */
  processConflicts(): void {
    const { confirmed, rejected } = this.votes.resolveConflicts();
    for (const hash of confirmed) {
      this.emit('block:confirmed', this.allBlocks.get(hash));
    }
    for (const hash of rejected) {
      this.handleRejectedBlock(hash);
    }
  }

  private handleRejectedBlock(blockHash: string): void {
    const block = this.allBlocks.get(blockHash);
    if (!block) return;

    // Remove from account chain
    const chain = this.accountChains.get(block.accountPub);
    if (chain) {
      const idx = chain.findIndex((b) => b.hash === blockHash);
      if (idx !== -1) chain.splice(idx, 1);
    }

    // Restore unclaimed send if this was a receive
    if (block.type === 'receive' && block.sendBlockHash) {
      const sendBlock = this.allBlocks.get(block.sendBlockHash);
      if (sendBlock && sendBlock.type === 'send' && sendBlock.recipient && sendBlock.amount) {
        this.unclaimedSends.set(block.sendBlockHash, {
          fromPub: sendBlock.accountPub,
          toPub: sendBlock.recipient,
          amount: sendBlock.amount,
        });
      }
    }

    this.allBlocks.delete(blockHash);
    this.emit('block:rejected', block);
  }

  getBlockStatus(blockHash: string): string {
    return this.votes.getStatus(blockHash);
  }

  // ──── Smart Contracts ────

  private executeContract(contractId: string, method: string, args: unknown[], caller: string): unknown {
    const contract = this.contracts.get(contractId);
    if (!contract) return null;

    try {
      const sandbox = {
        state: { ...contract.state },
        caller,
        args,
        balanceOf: (username: string) => {
          const acc = this.getAccountByUsername(username);
          return acc ? acc.balance : 0;
        },
        log: (...msgs: unknown[]) => {
          this.emit('contract:log', { contractId, messages: msgs });
        },
      };

      const fn = new Function('ctx', `
        with(ctx) {
          ${contract.code}
          if (typeof ${method} === 'function') return ${method}(...args);
          return null;
        }
      `);

      const result = fn(sandbox);
      contract.state = sandbox.state;
      this.emit('contract:executed', { contractId, method, result });
      return result;
    } catch (err) {
      this.emit('contract:error', { contractId, method, error: String(err) });
      return null;
    }
  }

  // ──── Queries ────

  getStats(): DAGStats {
    const now = Date.now();
    this.txTimestamps = this.txTimestamps.filter((t) => now - t < 10000);
    const tps = this.txTimestamps.length / 10;

    let confirmedCount = 0;
    let pendingCount = 0;
    for (const [hash] of this.allBlocks) {
      if (this.votes.isConfirmed(hash)) confirmedCount++;
      else pendingCount++;
    }

    return {
      network: this.network,
      totalAccounts: this.accounts.size,
      totalBlocks: this.allBlocks.size,
      pendingBlocks: pendingCount,
      confirmedBlocks: confirmedCount,
      tps: tps.toFixed(1),
    };
  }

  getAccountChain(pub: string): AccountBlock[] {
    return this.accountChains.get(pub) || [];
  }

  getAllBlocks(): AccountBlock[] {
    return Array.from(this.allBlocks.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  getBlock(hash: string): AccountBlock | undefined {
    return this.allBlocks.get(hash);
  }

  /**
   * Get unclaimed sends for a specific recipient.
   */
  getUnclaimedForAccount(pub: string): { sendBlockHash: string; fromPub: string; amount: number }[] {
    const result: { sendBlockHash: string; fromPub: string; amount: number }[] = [];
    for (const [hash, info] of this.unclaimedSends) {
      if (info.toPub === pub) {
        result.push({ sendBlockHash: hash, fromPub: info.fromPub, amount: info.amount });
      }
    }
    return result;
  }

  // ──── Reset ────

  reset(): void {
    this.accountChains.clear();
    this.allBlocks.clear();
    this.accounts.clear();
    this.usernameToPublicKey.clear();
    this.votes.clear();
    this.contracts.clear();
    this.unclaimedSends.clear();
    this.faceAccountCount.clear();
    this.txTimestamps = [];
  }
}
