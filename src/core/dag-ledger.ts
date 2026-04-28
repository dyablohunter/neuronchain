import {
  AccountBlock,
  AccountBlockType,
  ConfirmedBlock,
  StorageRegisterData,
  StorageRewardData,
  VERIFICATION_MINT_AMOUNT,
  BASE_STORAGE_RATE_MILLI,
  MAX_HEARTBEATS_PER_DAY,
  HEARTBEAT_INTERVAL_MS,
  REWARD_EPOCH_MS,
  createAccountBlock,
  validateBlockStructure,
  verifyBlockSignature,
} from './dag-block';
import { Account } from './account';
import { KeyPair } from './crypto';
import { VoteManager, Vote } from './vote';
import { EventEmitter } from './events';

const FACE_MATCH_THRESHOLD = 0.45;

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
 * Live storage provider profile - derived from on-chain blocks and updated
 * with off-chain metrics (latency, spot-check rate) by StorageManager.
 */
export interface StorageProvider {
  pub: string;
  /** Stable device ID of the registering machine - only that device serves content */
  deviceId: string;
  registeredAt: number;
  /** Offered capacity in GB from latest storage-register block */
  capacityGB: number;
  /** Timestamp of most recent storage-heartbeat block */
  lastHeartbeat: number;
  /** Heartbeat blocks in the last 24h window (recomputed on each new block) */
  heartbeatsLast24h: number;
  /** epochDay index of the last storage-reward block (0 = never rewarded) */
  lastRewardEpoch: number;
  /** Cumulative milli-UNIT minted via storage-reward blocks */
  totalEarned: number;
  // ── Off-chain metrics (updated by StorageManager, informational only) ────
  /** Rolling average retrieval latency from peer-signed receipts (0 = no data) */
  avgLatencyMs: number;
  /** Fraction of spot-check requests answered successfully (0–1, default 1) */
  spotCheckPassRate: number;
  /** Composite score: uptime × latency × spot-check factors (0–1) */
  score: number;
  /** Projected milli-UNIT earned per day at current score */
  earningRate: number;
}

export class DAGLedger extends EventEmitter {
  accountChains: Map<string, AccountBlock[]> = new Map();
  allBlocks: Map<string, AccountBlock> = new Map();
  accounts: Map<string, Account> = new Map();
  private usernameToPublicKey: Map<string, string> = new Map();
  votes: VoteManager = new VoteManager();
  contracts: Map<string, { owner: string; code: string; state: Record<string, unknown>; name: string; deployedAt: number }> = new Map();
  unclaimedSends: Map<string, { fromPub: string; toPub: string; amount: number }> = new Map();
  faceAccountCount: Map<string, number> = new Map();
  /** Per-contract execution queue - ensures calls execute sequentially, never concurrently */
  private contractQueues: Map<string, Promise<void>> = new Map();

  /** Decentralised storage ledger: provider pub → live profile */
  storageProviders: Map<string, StorageProvider> = new Map();

  network: NetworkType;
  private txTimestamps: number[] = [];

  constructor(network: NetworkType = 'testnet') {
    super();
    this.network = network;
  }

  // ── Account management ────────────────────────────────────────────────────

  registerAccount(account: Account): boolean {
    const existing = this.accounts.get(account.pub);
    if (existing) {
      // Merge remote data into the existing in-memory account.
      // Use the higher balance/nonce (authoritative chain state wins, but remote
      // may know about blocks we haven't seen yet).
      if (account.balance > existing.balance) existing.balance = account.balance;
      if (account.nonce > existing.nonce) existing.nonce = account.nonce;
      if (account.username && account.username !== existing.username && account.username !== account.pub) {
        this.usernameToPublicKey.delete(existing.username);
        existing.username = account.username;
        this.usernameToPublicKey.set(account.username, account.pub);
      }
      if (account.faceMapHash && !existing.faceMapHash) existing.faceMapHash = account.faceMapHash;
      if (account.faceDescriptor && !existing.faceDescriptor) existing.faceDescriptor = account.faceDescriptor;
      if (account.encryptedFaceDescriptor && !existing.encryptedFaceDescriptor) existing.encryptedFaceDescriptor = account.encryptedFaceDescriptor;
      if (account.linkedAnchor && !existing.linkedAnchor) existing.linkedAnchor = account.linkedAnchor;
      if (account.pqPub && !existing.pqPub) existing.pqPub = account.pqPub;
      if (account.pqKemPub && !existing.pqKemPub) existing.pqKemPub = account.pqKemPub;
      if (account.pinSalt && !existing.pinSalt) existing.pinSalt = account.pinSalt;
      if (account.pinVerifier && !existing.pinVerifier) existing.pinVerifier = account.pinVerifier;
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
    return pub ? this.accounts.get(pub) : undefined;
  }

  getAccountByPub(pub: string): Account | undefined { return this.accounts.get(pub); }

  resolveToPublicKey(identifier: string): string | undefined {
    if (this.accounts.has(identifier)) return identifier;
    return this.usernameToPublicKey.get(identifier);
  }

  getAccountBalance(pub: string): number {
    const chain = this.accountChains.get(pub);
    return chain?.length ? chain[chain.length - 1].balance : 0;
  }

  getAccountHead(pub: string): AccountBlock | null {
    const chain = this.accountChains.get(pub);
    return chain?.length ? chain[chain.length - 1] : null;
  }

  // ── Face limits ───────────────────────────────────────────────────────────

  getMaxAccountsPerFace(): number { return this.network === 'mainnet' ? 1 : 3; }
  getFaceAccountCount(faceMapHash: string): number { return this.faceAccountCount.get(faceMapHash) || 0; }

  countMatchingFaceAccounts(descriptor: number[], excludePub?: string): number {
    let count = 0;
    for (const account of this.accounts.values()) {
      if (excludePub && account.pub === excludePub) continue;
      if (account.faceDescriptor?.length === 128) {
        let sum = 0;
        for (let i = 0; i < 128; i++) sum += (descriptor[i] - account.faceDescriptor[i]) ** 2;
        if (Math.sqrt(sum) < FACE_MATCH_THRESHOLD) count++;
      }
    }
    return count;
  }

  rebuildFaceAccountCount(): void {
    this.faceAccountCount.clear();
    for (const chain of this.accountChains.values()) {
      const openBlock = chain[0];
      if (openBlock?.type === 'open' && openBlock.faceMapHash) {
        const prev = this.faceAccountCount.get(openBlock.faceMapHash) || 0;
        this.faceAccountCount.set(openBlock.faceMapHash, prev + 1);
      }
    }
  }

  // ── Block creation ────────────────────────────────────────────────────────

  async openAccount(pub: string, faceMapHash: string, keys: KeyPair, faceDescriptor?: number[]): Promise<AccountBlock> {
    let count: number;
    if (faceDescriptor?.length === 128) {
      count = this.countMatchingFaceAccounts(faceDescriptor, pub);
    } else {
      count = this.getFaceAccountCount(faceMapHash);
    }
    const max = this.getMaxAccountsPerFace();
    if (count >= max) throw new Error(`Face already used for ${count} account(s). Limit: ${max} per face on ${this.network}.`);

    const block = await createAccountBlock({
      accountPub: pub, index: 0, type: 'open',
      previousHash: '0'.repeat(64), balance: VERIFICATION_MINT_AMOUNT, faceMapHash,
    }, keys);
    await this.addBlock(block);
    return block;
  }

  async createSend(senderPub: string, recipientIdentifier: string, amount: number, keys: KeyPair): Promise<{ block?: AccountBlock; error?: string }> {
    const recipientPub = this.resolveToPublicKey(recipientIdentifier);
    if (!recipientPub) return { error: 'Recipient not found' };
    const head = this.getAccountHead(senderPub);
    if (!head) return { error: 'Account not opened' };
    if (head.balance < amount) return { error: 'Insufficient balance' };
    if (amount <= 0) return { error: 'Amount must be positive' };
    const block = await createAccountBlock({
      accountPub: senderPub, index: head.index + 1, type: 'send',
      previousHash: head.hash, balance: head.balance - amount,
      recipient: recipientPub, amount,
    }, keys);
    return { block };
  }

  async createReceive(recipientPub: string, sendBlockHash: string, keys: KeyPair): Promise<{ block?: AccountBlock; error?: string }> {
    const unclaimed = this.unclaimedSends.get(sendBlockHash);
    if (!unclaimed) return { error: 'Send block not found or already claimed' };
    if (unclaimed.toPub !== recipientPub) return { error: 'This send is not addressed to you' };
    const head = this.getAccountHead(recipientPub);
    if (!head) return { error: 'Account not opened' };
    const block = await createAccountBlock({
      accountPub: recipientPub, index: head.index + 1, type: 'receive',
      previousHash: head.hash, balance: head.balance + unclaimed.amount,
      sendBlockHash, sendFrom: unclaimed.fromPub, receiveAmount: unclaimed.amount,
    }, keys);
    return { block };
  }

  async createDeploy(senderPub: string, name: string, code: string, keys: KeyPair): Promise<{ block?: AccountBlock; error?: string }> {
    const head = this.getAccountHead(senderPub);
    if (!head) return { error: 'Account not opened' };
    const block = await createAccountBlock({
      accountPub: senderPub, index: head.index + 1, type: 'deploy',
      previousHash: head.hash, balance: head.balance,
      contractData: JSON.stringify({ name, code }),
    }, keys);
    return { block };
  }

  async createCall(senderPub: string, contractId: string, method: string, args: unknown[], keys: KeyPair): Promise<{ block?: AccountBlock; error?: string }> {
    const head = this.getAccountHead(senderPub);
    if (!head) return { error: 'Account not opened' };
    const block = await createAccountBlock({
      accountPub: senderPub, index: head.index + 1, type: 'call',
      previousHash: head.hash, balance: head.balance,
      contractData: JSON.stringify({ contractId, method, args }),
    }, keys);
    return { block };
  }

  /**
   * Create an account update block to change face hash, linked anchor, and/or PQ keys on-chain.
   * Must be signed with the account's existing private key — proves ownership.
   */
  async createUpdate(
    pub: string,
    keys: KeyPair,
    changes: {
      newFaceMapHash?: string;
      newLinkedAnchor: string;
      newPQPub?: string;
      newPQKemPub?: string;
    },
  ): Promise<{ block?: AccountBlock; error?: string }> {
    const head = this.getAccountHead(pub);
    if (!head) return { error: 'Account not opened' };
    const block = await createAccountBlock({
      accountPub: pub, index: head.index + 1, type: 'update',
      previousHash: head.hash, balance: head.balance,
      updateData: JSON.stringify(changes),
    }, keys);
    return { block };
  }

  // ── Storage ledger block creation ─────────────────────────────────────────

  /**
   * Register as a storage provider. capacityGB = 0 deregisters.
   */
  async createStorageRegister(pub: string, capacityGB: number, keys: KeyPair, deviceId?: string): Promise<{ block?: AccountBlock; error?: string }> {
    const head = this.getAccountHead(pub);
    if (!head) return { error: 'Account not opened' };
    if (capacityGB <= 0) return { error: 'capacityGB must be a positive number' };
    const block = await createAccountBlock({
      accountPub: pub, index: head.index + 1, type: 'storage-register',
      previousHash: head.hash, balance: head.balance,
      contractData: JSON.stringify({ type: 'storage-register', capacityGB, deviceId } satisfies StorageRegisterData),
    }, keys);
    return { block };
  }

  /** Remove the account from the storage ledger entirely. */
  async createStorageDeregister(pub: string, keys: KeyPair): Promise<{ block?: AccountBlock; error?: string }> {
    const provider = this.storageProviders.get(pub);
    if (!provider || provider.capacityGB === 0) return { error: 'Not a registered storage provider' };
    const head = this.getAccountHead(pub);
    if (!head) return { error: 'Account not opened' };
    const block = await createAccountBlock({
      accountPub: pub, index: head.index + 1, type: 'storage-deregister',
      previousHash: head.hash, balance: head.balance,
    }, keys);
    return { block };
  }

  /**
   * Broadcast a proof-of-uptime heartbeat. Enforces minimum 4h interval.
   */
  async createStorageHeartbeat(pub: string, keys: KeyPair): Promise<{ block?: AccountBlock; error?: string }> {
    const provider = this.storageProviders.get(pub);
    if (!provider || provider.capacityGB === 0) return { error: 'Not a registered storage provider' };

    // Enforce minimum interval between heartbeats
    if (provider.lastHeartbeat > 0 && Date.now() - provider.lastHeartbeat < HEARTBEAT_INTERVAL_MS - 60_000) {
      return { error: `Heartbeat interval not reached (next in ${Math.ceil((HEARTBEAT_INTERVAL_MS - (Date.now() - provider.lastHeartbeat)) / 60000)}min)` };
    }

    const head = this.getAccountHead(pub);
    if (!head) return { error: 'Account not opened' };
    const block = await createAccountBlock({
      accountPub: pub, index: head.index + 1, type: 'storage-heartbeat',
      previousHash: head.hash, balance: head.balance,
    }, keys);
    return { block };
  }

  /**
   * Issue a daily storage reward. Validates amount against on-chain heartbeat count
   * and registered capacity. Mints new UNIT into the provider's balance.
   */
  async createStorageReward(pub: string, keys: KeyPair): Promise<{ block?: AccountBlock; error?: string }> {
    const provider = this.storageProviders.get(pub);
    if (!provider || provider.capacityGB === 0) return { error: 'Not a registered storage provider' };

    const epochDay = Math.floor(Date.now() / REWARD_EPOCH_MS);
    if (provider.lastRewardEpoch >= epochDay) return { error: 'Storage reward already claimed for today' };

    // Use capacity at epoch start - not current capacity - to prevent bumping GB just before claiming
    const capacityAtEpochStart = this.getCapacityAtEpochStart(pub, epochDay);
    if (capacityAtEpochStart === 0) return { error: 'Not registered at epoch start - no reward eligible' };

    const heartbeatCount = this.countHeartbeatsInEpoch(pub, epochDay);
    if (heartbeatCount === 0) return { error: 'No heartbeat blocks recorded today - cannot claim reward' };

    const uptimeFactor = Math.min(heartbeatCount / MAX_HEARTBEATS_PER_DAY, 1.0);
    const amount = Math.floor(BASE_STORAGE_RATE_MILLI * capacityAtEpochStart * uptimeFactor);
    if (amount <= 0) return { error: 'Calculated reward is zero' };

    const head = this.getAccountHead(pub);
    if (!head) return { error: 'Account not opened' };

    const rewardData: StorageRewardData = {
      type: 'storage-reward',
      epochDay,
      storedGB: capacityAtEpochStart,
      heartbeatCount,
      amount,
    };

    const block = await createAccountBlock({
      accountPub: pub, index: head.index + 1, type: 'storage-reward',
      previousHash: head.hash, balance: head.balance + amount,
      contractData: JSON.stringify(rewardData),
    }, keys);
    return { block };
  }

  // ── Storage scoring (also called by StorageManager to update off-chain metrics) ──

  updateProviderScore(provider: StorageProvider): void {
    const uptimeFactor = Math.max(0.1, Math.min(1.0,
      provider.heartbeatsLast24h / MAX_HEARTBEATS_PER_DAY));

    const latencyFactor = provider.avgLatencyMs > 0
      ? Math.max(0.1, Math.min(1.0, 1_000 / provider.avgLatencyMs)) // 1000ms target
      : 1.0; // no receipts yet → full score

    const spotFactor = Math.max(0.1, Math.min(1.0, provider.spotCheckPassRate));

    provider.score = uptimeFactor * latencyFactor * spotFactor;
    provider.earningRate = Math.floor(BASE_STORAGE_RATE_MILLI * provider.capacityGB * provider.score);
  }

  // ── Block submission ──────────────────────────────────────────────────────

  async addBlock(block: AccountBlock): Promise<{ success: boolean; error?: string }> {
    if (this.allBlocks.has(block.hash)) return { success: true };

    const account = this.accounts.get(block.accountPub);
    const sigValid = await verifyBlockSignature(block, account?.pqPub);
    if (!sigValid) return { success: false, error: 'Invalid signature' };

    const parent = block.type === 'open' ? null : this.allBlocks.get(block.previousHash) || null;
    const validation = validateBlockStructure(block, parent);
    if (!validation.valid) return { success: false, error: validation.error };

    if (block.type === 'receive') {
      const sendBlock = this.allBlocks.get(block.sendBlockHash!);
      if (!sendBlock) return { success: false, error: 'Referenced send block not found' };
      if (sendBlock.type !== 'send') return { success: false, error: 'Referenced block is not a send' };
      if (sendBlock.recipient !== block.accountPub) return { success: false, error: 'Send block recipient mismatch' };
      if (sendBlock.amount !== block.receiveAmount) return { success: false, error: 'Amount mismatch' };
    }

    // storage-reward semantic validation (requires chain state)
    if (block.type === 'storage-reward' && block.contractData) {
      const rewardErr = this.validateStorageReward(block);
      if (rewardErr) return { success: false, error: rewardErr };
    }

    // storage-heartbeat minimum interval check
    if (block.type === 'storage-heartbeat') {
      const provider = this.storageProviders.get(block.accountPub);
      if (!provider || provider.capacityGB === 0) {
        return { success: false, error: 'storage-heartbeat: account is not a registered storage provider' };
      }
      if (provider.lastHeartbeat > 0 && block.timestamp - provider.lastHeartbeat < HEARTBEAT_INTERVAL_MS - 60_000) {
        return { success: false, error: 'storage-heartbeat interval not reached' };
      }
    }

    const voteResult = this.votes.registerBlock(block.hash, block.previousHash, block.accountPub);

    // Reject a second OPEN block for an account that already has one.
    // A peer re-broadcasting a stale or forked OPEN block should not corrupt the chain.
    if (block.type === 'open' && this.accountChains.has(block.accountPub)) {
      return { success: false, error: 'Account already has an open block' };
    }

    this.allBlocks.set(block.hash, block);
    if (!this.accountChains.has(block.accountPub)) this.accountChains.set(block.accountPub, []);
    this.accountChains.get(block.accountPub)!.push(block);

    if (block.type === 'send' && block.recipient && block.amount) {
      this.unclaimedSends.set(block.hash, { fromPub: block.accountPub, toPub: block.recipient, amount: block.amount });
    }
    if (block.type === 'receive' && block.sendBlockHash) {
      this.unclaimedSends.delete(block.sendBlockHash);
    }

    if (block.type === 'deploy' && block.contractData) {
      try {
        const data = JSON.parse(block.contractData);
        this.contracts.set(block.hash, { owner: block.accountPub, code: data.code, state: {}, name: data.name || 'Unnamed', deployedAt: block.timestamp });
        this.emit('contract:deployed', { id: block.hash, name: data.name });
      } catch { /* invalid */ }
    }

    if (block.type === 'call' && block.contractData && voteResult === 'confirmed') {
      try {
        const data = JSON.parse(block.contractData);
        this.enqueueContractExecution(data.contractId, data.method, data.args || [], block.accountPub);
      } catch { /* invalid */ }
    }

    if (block.type === 'storage-register' && block.contractData) {
      try {
        const data = JSON.parse(block.contractData) as StorageRegisterData;
        const existing = this.storageProviders.get(block.accountPub);
        const provider: StorageProvider = {
          pub: block.accountPub,
          deviceId: data.deviceId ?? existing?.deviceId ?? '',
          registeredAt: existing?.registeredAt ?? block.timestamp,
          capacityGB: data.capacityGB,
          lastHeartbeat: existing?.lastHeartbeat ?? 0,
          heartbeatsLast24h: existing?.heartbeatsLast24h ?? 0,
          lastRewardEpoch: existing?.lastRewardEpoch ?? 0,
          totalEarned: existing?.totalEarned ?? 0,
          avgLatencyMs: existing?.avgLatencyMs ?? 0,
          spotCheckPassRate: existing?.spotCheckPassRate ?? 1.0,
          score: existing?.score ?? 1.0,
          earningRate: 0,
        };
        this.updateProviderScore(provider);
        this.storageProviders.set(block.accountPub, provider);
        this.emit('storage:registered', { pub: block.accountPub, capacityGB: data.capacityGB });
      } catch { /* invalid */ }
    }

    if (block.type === 'storage-deregister') {
      this.storageProviders.delete(block.accountPub);
      this.emit('storage:deregistered', { pub: block.accountPub });
    }

    if (block.type === 'storage-heartbeat') {
      const provider = this.storageProviders.get(block.accountPub);
      if (provider) {
        provider.lastHeartbeat = block.timestamp;
        provider.heartbeatsLast24h = this.countHeartbeatsLast24h(block.accountPub, block.timestamp);
        this.updateProviderScore(provider);
        this.emit('storage:heartbeat', { pub: block.accountPub, timestamp: block.timestamp });
      }
    }

    if (block.type === 'storage-reward' && block.contractData) {
      try {
        const data = JSON.parse(block.contractData) as StorageRewardData;
        const provider = this.storageProviders.get(block.accountPub);
        if (provider) {
          provider.lastRewardEpoch = data.epochDay;
          provider.totalEarned += data.amount;
          this.updateProviderScore(provider);
        }
        this.emit('storage:reward', { pub: block.accountPub, amount: data.amount, epochDay: data.epochDay });
      } catch { /* invalid */ }
    }

    if (block.type === 'open' && block.faceMapHash) {
      const prev = this.faceAccountCount.get(block.faceMapHash) || 0;
      this.faceAccountCount.set(block.faceMapHash, prev + 1);
    }

    if (block.type === 'update' && block.updateData) {
      try {
        const data = JSON.parse(block.updateData) as {
          newFaceMapHash?: string;
          newLinkedAnchor: string;
          newPQPub?: string;
          newPQKemPub?: string;
        };
        const acc = this.accounts.get(block.accountPub);
        if (acc) {
          if (data.newFaceMapHash) {
            // Update face count map
            const oldHash = acc.faceMapHash;
            const oldCount = this.faceAccountCount.get(oldHash) || 0;
            if (oldCount > 0) this.faceAccountCount.set(oldHash, oldCount - 1);
            const newCount = this.faceAccountCount.get(data.newFaceMapHash) || 0;
            this.faceAccountCount.set(data.newFaceMapHash, newCount + 1);
            acc.faceMapHash = data.newFaceMapHash;
          }
          if (data.newLinkedAnchor) acc.linkedAnchor = data.newLinkedAnchor;
          if (data.newPQPub) acc.pqPub = data.newPQPub;
          if (data.newPQKemPub) acc.pqKemPub = data.newPQKemPub;
          this.emit('account:updated', acc);
        }
      } catch { /* invalid updateData */ }
    }

    const acc = this.accounts.get(block.accountPub);
    if (acc) { acc.balance = block.balance; acc.nonce = block.index; }

    this.txTimestamps.push(Date.now());
    this.emit(voteResult === 'confirmed' ? 'block:confirmed' : 'block:conflict', block);
    this.emit('block:added', block);
    return { success: true };
  }

  // ── Storage reward validation (semantic, requires chain state) ────────────

  private validateStorageReward(block: AccountBlock): string | null {
    try {
      const data = JSON.parse(block.contractData!) as StorageRewardData;
      const provider = this.storageProviders.get(block.accountPub);
      if (!provider || provider.capacityGB === 0) {
        return 'storage-reward: account is not a registered storage provider';
      }
      if (provider.lastRewardEpoch >= data.epochDay) {
        return `storage-reward: epoch ${data.epochDay} already rewarded`;
      }
      // Validate storedGB against capacity at epoch start - not current capacity
      const capacityAtEpochStart = this.getCapacityAtEpochStart(block.accountPub, data.epochDay);
      if (capacityAtEpochStart === 0) {
        return 'storage-reward: not registered at epoch start';
      }
      if (data.storedGB !== capacityAtEpochStart) {
        return `storage-reward: declared storedGB (${data.storedGB}) does not match epoch-start capacity (${capacityAtEpochStart})`;
      }
      const heartbeatCount = this.countHeartbeatsInEpoch(block.accountPub, data.epochDay);
      if (heartbeatCount === 0) {
        return 'storage-reward: no heartbeat blocks found for this epoch';
      }
      const uptimeFactor = Math.min(heartbeatCount / MAX_HEARTBEATS_PER_DAY, 1.0);
      const maxAllowed = Math.floor(BASE_STORAGE_RATE_MILLI * capacityAtEpochStart * uptimeFactor);
      // Allow 10% tolerance for timing edge cases
      if (data.amount > Math.ceil(maxAllowed * 1.1)) {
        return `storage-reward: amount ${data.amount} exceeds maximum ${maxAllowed} (${capacityAtEpochStart}GB × ${uptimeFactor.toFixed(2)} uptime)`;
      }
      return null;
    } catch {
      return 'storage-reward: invalid contractData';
    }
  }

  // ── Heartbeat helpers ─────────────────────────────────────────────────────

  /** Count heartbeat blocks in the 24h window ending at refTime */
  private countHeartbeatsLast24h(pub: string, refTime: number): number {
    const chain = this.accountChains.get(pub) || [];
    const cutoff = refTime - 24 * 60 * 60 * 1000;
    return chain.filter(b => b.type === 'storage-heartbeat' && b.timestamp >= cutoff).length;
  }

  /** Count heartbeat blocks in the 24h window for a given epoch day */
  countHeartbeatsInEpoch(pub: string, epochDay: number): number {
    const chain = this.accountChains.get(pub) || [];
    const epochStart = epochDay * REWARD_EPOCH_MS;
    const epochEnd = epochStart + REWARD_EPOCH_MS;
    return chain.filter(b => b.type === 'storage-heartbeat' && b.timestamp >= epochStart && b.timestamp < epochEnd).length;
  }

  /**
   * Return the registered capacity (GB) at the start of a given epoch day.
   * Uses the last storage-register block committed before epochStart.
   * Returns 0 if no registration existed at that time.
   */
  getCapacityAtEpochStart(pub: string, epochDay: number): number {
    const chain = this.accountChains.get(pub) || [];
    const epochStart = epochDay * REWARD_EPOCH_MS;
    // Walk backwards to find the last storage-register block before the epoch started
    let capacity = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      const b = chain[i];
      if (b.timestamp >= epochStart) continue;
      if (b.type === 'storage-deregister') { capacity = 0; break; }
      if (b.type === 'storage-register' && b.contractData) {
        try {
          const d = JSON.parse(b.contractData) as StorageRegisterData;
          capacity = d.capacityGB;
        } catch { /* skip */ }
        break;
      }
    }
    return capacity;
  }

  // ── Voting ────────────────────────────────────────────────────────────────

  castVote(vote: Vote): void {
    let verifiedStake: number;
    if (vote.chainHeadHash) {
      const headBlock = this.allBlocks.get(vote.chainHeadHash);
      if (!headBlock) {
        verifiedStake = this.getAccountBalance(vote.voterPub);
      } else if (headBlock.accountPub !== vote.voterPub) {
        return;
      } else {
        verifiedStake = headBlock.balance;
      }
    } else {
      verifiedStake = this.getAccountBalance(vote.voterPub);
    }
    if (verifiedStake <= 0) return;
    this.votes.addVote({ ...vote, stake: verifiedStake });
  }

  processConflicts(): void {
    const { confirmed, rejected } = this.votes.resolveConflicts();
    for (const hash of confirmed) this.emit('block:confirmed', this.allBlocks.get(hash));
    for (const hash of rejected) this.handleRejectedBlock(hash);
  }

  private handleRejectedBlock(blockHash: string): void {
    const block = this.allBlocks.get(blockHash);
    if (!block) return;
    const chain = this.accountChains.get(block.accountPub);
    if (chain) {
      const idx = chain.findIndex(b => b.hash === blockHash);
      if (idx !== -1) chain.splice(idx, 1);
    }
    if (block.type === 'receive' && block.sendBlockHash) {
      const sendBlock = this.allBlocks.get(block.sendBlockHash);
      if (sendBlock?.type === 'send' && sendBlock.recipient && sendBlock.amount) {
        this.unclaimedSends.set(block.sendBlockHash, { fromPub: sendBlock.accountPub, toPub: sendBlock.recipient, amount: sendBlock.amount });
      }
    }
    this.allBlocks.delete(blockHash);
    this.emit('block:rejected', block);
  }

  getBlockStatus(blockHash: string): string { return this.votes.getStatus(blockHash); }

  // ── Smart Contracts (Web Worker sandbox) ─────────────────────────────────

  private static readonly CONTRACT_TIMEOUT_MS = 3000;

  private enqueueContractExecution(contractId: string, method: string, args: unknown[], caller: string): void {
    const prev = this.contractQueues.get(contractId) ?? Promise.resolve();
    const next = prev.then(() => this.executeContractWorker(contractId, method, args, caller));
    this.contractQueues.set(contractId, next.catch(() => { /* keep queue alive on error */ }));
  }

  private executeContractWorker(contractId: string, method: string, args: unknown[], caller: string): Promise<void> {
    const contract = this.contracts.get(contractId);
    if (!contract) return Promise.resolve();
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(method)) return Promise.resolve();

    const workerCode = `
      "use strict";
      const importScripts = undefined;
      const XMLHttpRequest = undefined;
      const WebSocket = undefined;
      const EventSource = undefined;
      const indexedDB = undefined;
      const caches = undefined;
      const navigator = undefined;
      const location = undefined;

      self.onmessage = function(e) {
        const { state, caller, args, method } = e.data;
        try {
          const contractFn = new Function('state', 'caller', 'args',
            ${JSON.stringify(contract.code)} +
            "\\nif (typeof " + method + " === 'function') return " + method + "(...args);\\nreturn null;"
          );
          const result = contractFn(state, caller, args);
          self.postMessage({ ok: true, result, state });
        } catch (err) {
          self.postMessage({ ok: false, error: String(err) });
        }
      };
    `;

    return new Promise((resolve) => {
      try {
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);

        const timeout = setTimeout(() => {
          worker.terminate();
          URL.revokeObjectURL(url);
          this.emit('contract:error', { contractId, method, error: 'Execution timed out' });
          resolve();
        }, DAGLedger.CONTRACT_TIMEOUT_MS);

        worker.onmessage = (e: MessageEvent) => {
          clearTimeout(timeout);
          worker.terminate();
          URL.revokeObjectURL(url);
          const data = e.data as { ok: boolean; result?: unknown; state?: Record<string, unknown>; error?: string };
          if (data.ok) {
            if (data.state) contract.state = data.state;
            this.emit('contract:executed', { contractId, method, result: data.result });
          } else {
            this.emit('contract:error', { contractId, method, error: data.error });
          }
          resolve();
        };

        worker.onerror = (err: ErrorEvent) => {
          clearTimeout(timeout);
          worker.terminate();
          URL.revokeObjectURL(url);
          this.emit('contract:error', { contractId, method, error: err.message });
          resolve();
        };

        worker.postMessage({ state: { ...contract.state }, caller, args, method });
      } catch (err) {
        this.emit('contract:error', { contractId, method, error: String(err) });
        resolve();
      }
    });
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getStats(): DAGStats {
    const now = Date.now();
    this.txTimestamps = this.txTimestamps.filter(t => now - t < 10000);
    let confirmedCount = 0, pendingCount = 0;
    for (const [hash] of this.allBlocks) {
      if (this.votes.isConfirmed(hash)) confirmedCount++;
      else pendingCount++;
    }
    return {
      network: this.network, totalAccounts: this.accounts.size,
      totalBlocks: this.allBlocks.size, pendingBlocks: pendingCount,
      confirmedBlocks: confirmedCount, tps: (this.txTimestamps.length / 10).toFixed(1),
    };
  }

  getAccountChain(pub: string): AccountBlock[] { return this.accountChains.get(pub) || []; }
  getAllBlocks(): AccountBlock[] { return Array.from(this.allBlocks.values()).sort((a, b) => b.timestamp - a.timestamp); }
  getBlock(hash: string): AccountBlock | undefined { return this.allBlocks.get(hash); }

  getUnclaimedForAccount(pub: string): { sendBlockHash: string; fromPub: string; amount: number }[] {
    const result: { sendBlockHash: string; fromPub: string; amount: number }[] = [];
    for (const [hash, info] of this.unclaimedSends) {
      if (info.toPub === pub) result.push({ sendBlockHash: hash, fromPub: info.fromPub, amount: info.amount });
    }
    return result;
  }

  /** Get all active storage providers (capacityGB > 0), sorted by score descending */
  getStorageProviders(): StorageProvider[] {
    return Array.from(this.storageProviders.values())
      .filter(p => p.capacityGB > 0)
      .sort((a, b) => b.score - a.score);
  }

  reset(): void {
    this.accountChains.clear(); this.allBlocks.clear(); this.accounts.clear();
    this.usernameToPublicKey.clear(); this.votes.clear(); this.contracts.clear(); this.contractQueues.clear();
    this.unclaimedSends.clear(); this.faceAccountCount.clear();
    this.storageProviders.clear();
    this.txTimestamps = [];
  }
}
