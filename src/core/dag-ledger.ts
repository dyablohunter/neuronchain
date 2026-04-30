import {
  AccountBlock,
  AccountBlockType,
  ConfirmedBlock,
  StorageRegisterData,
  StorageHeartbeatData,
  StorageRewardData,
  VERIFICATION_MINT_AMOUNT,
  BASE_STORAGE_RATE_MILLI,
  MAX_HEARTBEATS_PER_DAY,
  HEARTBEAT_INTERVAL_MS,
  REWARD_EPOCH_MS,
  GB_BYTES,
  createAccountBlock,
  validateBlockStructure,
  verifyBlockSignature,
  hashAccountBlock,
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
  /** Offered capacity in GB from latest storage-register block (upper bound / declared limit) */
  capacityGB: number;
  /** Actual bytes stored as reported in the latest heartbeat (0 = no heartbeat with this field yet) */
  lastActualStoredBytes: number;
  /** Timestamp of most recent storage-heartbeat block */
  lastHeartbeat: number;
  /** Heartbeat blocks in the last 24h window (recomputed on each new block) */
  heartbeatsLast24h: number;
  /** epochDay index of the last storage-reward block (0 = never rewarded) */
  lastRewardEpoch: number;
  /** Cumulative milli-UNIT minted via storage-reward blocks */
  totalEarned: number;
  /** Current smoke Hub address - set from heartbeat contractData, used for targeted retrieval */
  smokeAddr?: string;
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
  /** P3: heartbeat epoch index - pub → epochDay → count */
  private heartbeatsByEpoch: Map<string, Map<number, number>> = new Map();

  network: NetworkType;
  private txTimestamps: number[] = [];
  /** A2: running counters, maintained incrementally to avoid O(n) scan in getStats() */
  private _confirmedCount = 0;
  private _pendingCount = 0;
  /** P5: insertion-order hash list; getAllBlocks() returns the last MAX_BLOCKS_DISPLAY */
  private blockInsertionOrder: string[] = [];
  private static readonly MAX_BLOCKS_DISPLAY = 500;
  /** H5: hard cap on in-memory chain length per account */
  private static readonly MAX_CHAIN_MEMORY = 5000;

  constructor(network: NetworkType = 'testnet') {
    super();
    this.network = network;
  }

  // ── Account management ────────────────────────────────────────────────────

  registerAccount(account: Account): boolean {
    const existing = this.accounts.get(account.pub);
    if (existing) {
      // C1: balance/nonce are authoritative from on-chain blocks only - never merge from gossip.
      // H1: raw faceDescriptor is not propagated - faceMapHash (public hash) is sufficient.
      if (account.username && account.username !== existing.username && account.username !== account.pub) {
        this.usernameToPublicKey.delete(existing.username);
        existing.username = account.username;
        this.usernameToPublicKey.set(account.username, account.pub);
      }
      if (account.faceMapHash && !existing.faceMapHash) existing.faceMapHash = account.faceMapHash;
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
   * Must be signed with the account's existing private key - proves ownership.
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
      contractData: JSON.stringify({ capacityGB: provider.capacityGB }),
    }, keys);
    return { block };
  }

  /**
   * Broadcast a proof-of-uptime heartbeat. Enforces minimum 4h interval.
   * smokeAddr is included in contractData so peers can discover the provider's
   * current WebRTC address from the chain without waiting for a live peer-addrs broadcast.
   */
  async createStorageHeartbeat(pub: string, keys: KeyPair, smokeAddr?: string, actualStoredBytes?: number): Promise<{ block?: AccountBlock; error?: string }> {
    const provider = this.storageProviders.get(pub);
    if (!provider || provider.capacityGB === 0) return { error: 'Not a registered storage provider' };

    // Enforce minimum interval between heartbeats
    if (provider.lastHeartbeat > 0 && Date.now() - provider.lastHeartbeat < HEARTBEAT_INTERVAL_MS - 60_000) {
      return { error: `Heartbeat interval not reached (next in ${Math.ceil((HEARTBEAT_INTERVAL_MS - (Date.now() - provider.lastHeartbeat)) / 60000)}min)` };
    }

    const head = this.getAccountHead(pub);
    if (!head) return { error: 'Account not opened' };
    const heartbeatData: StorageHeartbeatData = { type: 'storage-heartbeat', smokeAddr, actualStoredBytes };
    const block = await createAccountBlock({
      accountPub: pub, index: head.index + 1, type: 'storage-heartbeat',
      previousHash: head.hash, balance: head.balance,
      contractData: JSON.stringify(heartbeatData),
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
    // Guard against two devices with the same account both issuing a reward before
    // either block is accepted (epoch race). Check the chain directly.
    const chain = this.accountChains.get(pub) || [];
    const alreadyInChain = chain.some(b => {
      if (b.type !== 'storage-reward' || !b.contractData) return false;
      try { return (JSON.parse(b.contractData) as StorageRewardData).epochDay === epochDay; }
      catch { return false; }
    });
    if (alreadyInChain) return { error: 'Storage reward already in chain for today' };

    // Use capacity at epoch start - not current capacity - to prevent bumping GB just before claiming
    const capacityAtEpochStart = this.getCapacityAtEpochStart(pub, epochDay);
    if (capacityAtEpochStart === 0) return { error: 'Not registered at epoch start - no reward eligible' };

    const heartbeatCount = this.countHeartbeatsInEpoch(pub, epochDay);
    if (heartbeatCount === 0) return { error: 'No heartbeat blocks recorded today - cannot claim reward' };

    const uptimeFactor = Math.min(heartbeatCount / MAX_HEARTBEATS_PER_DAY, 1.0);
    // Use actual stored GB from heartbeat data; fall back to declared capacity when
    // heartbeats predate the actualStoredBytes field (backward compatibility).
    const actualStoredGB = this.getActualStoredGBInEpoch(pub, epochDay);
    const effectiveGB = actualStoredGB > 0
      ? Math.min(actualStoredGB, capacityAtEpochStart)
      : capacityAtEpochStart;
    const amount = Math.floor(BASE_STORAGE_RATE_MILLI * effectiveGB * uptimeFactor);
    if (amount <= 0) return { error: 'Calculated reward is zero' };

    const head = this.getAccountHead(pub);
    if (!head) return { error: 'Account not opened' };

    const rewardData: StorageRewardData = {
      type: 'storage-reward',
      epochDay,
      storedGB: effectiveGB,
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
    // Earning rate reflects actual stored GB (capped at declared capacity), not just declared capacity
    const effectiveGB = provider.lastActualStoredBytes > 0
      ? Math.min(provider.lastActualStoredBytes / GB_BYTES, provider.capacityGB)
      : provider.capacityGB;
    provider.earningRate = Math.floor(BASE_STORAGE_RATE_MILLI * effectiveGB * provider.score);
  }

  // ── Block submission ──────────────────────────────────────────────────────

  async addBlock(block: AccountBlock): Promise<{ success: boolean; error?: string }> {
    if (this.allBlocks.has(block.hash)) return { success: true };

    // G2: verify the stored hash matches the actual block data before trusting it
    const expectedHash = await hashAccountBlock(block);
    if (expectedHash !== block.hash) return { success: false, error: 'Block hash mismatch' };

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
      // D4: reject heartbeats with timestamps far from the accepting node's wall clock
      if (Math.abs(block.timestamp - Date.now()) > 10 * 60 * 1000) {
        return { success: false, error: 'storage-heartbeat: timestamp too far from current time' };
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
          lastActualStoredBytes: existing?.lastActualStoredBytes ?? 0,
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
      // P3: maintain epoch index for O(1) heartbeat count queries
      const epochDay = Math.floor(block.timestamp / REWARD_EPOCH_MS);
      const byEpoch = this.heartbeatsByEpoch.get(block.accountPub) ?? new Map<number, number>();
      byEpoch.set(epochDay, (byEpoch.get(epochDay) ?? 0) + 1);
      this.heartbeatsByEpoch.set(block.accountPub, byEpoch);

      const provider = this.storageProviders.get(block.accountPub);
      if (provider) {
        provider.lastHeartbeat = block.timestamp;
        provider.heartbeatsLast24h = this.countHeartbeatsLast24h(block.accountPub, block.timestamp);
        if (block.contractData) {
          try {
            const hbData = JSON.parse(block.contractData) as StorageHeartbeatData;
            if (hbData.smokeAddr) provider.smokeAddr = hbData.smokeAddr;
            if (typeof hbData.actualStoredBytes === 'number') {
              provider.lastActualStoredBytes = hbData.actualStoredBytes;
            }
          } catch { /* ignore malformed */ }
        }
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

    // P5: maintain insertion-order list for getAllBlocks()
    this.blockInsertionOrder.push(block.hash);
    // Trim to 2× display budget so GC can collect the oldest pointers
    if (this.blockInsertionOrder.length > DAGLedger.MAX_BLOCKS_DISPLAY * 2) {
      this.blockInsertionOrder = this.blockInsertionOrder.slice(-DAGLedger.MAX_BLOCKS_DISPLAY);
    }

    // H5: cap in-memory chain length per account
    this.pruneAccountChain(block.accountPub);

    this.txTimestamps.push(Date.now());

    // A2: maintain running counters
    if (voteResult === 'confirmed') this._confirmedCount++;
    else this._pendingCount++;

    this.emit(voteResult === 'confirmed' ? 'block:confirmed' : 'block:conflict', block);
    this.emit('block:added', block);
    return { success: true };
  }

  // H5: drop blocks that have rolled off the in-memory window
  private pruneAccountChain(pub: string): void {
    const chain = this.accountChains.get(pub);
    if (!chain || chain.length <= DAGLedger.MAX_CHAIN_MEMORY) return;
    const pruned = chain.splice(0, chain.length - DAGLedger.MAX_CHAIN_MEMORY);
    for (const b of pruned) this.allBlocks.delete(b.hash);
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
      const heartbeatCount = this.countHeartbeatsInEpoch(block.accountPub, data.epochDay);
      if (heartbeatCount === 0) {
        return 'storage-reward: no heartbeat blocks found for this epoch';
      }
      // Compute the effective GB the same way createStorageReward does
      const actualStoredGB = this.getActualStoredGBInEpoch(block.accountPub, data.epochDay);
      const effectiveGB = actualStoredGB > 0
        ? Math.min(actualStoredGB, capacityAtEpochStart)
        : capacityAtEpochStart;
      if (data.storedGB > effectiveGB + 1e-9) {
        return `storage-reward: storedGB (${data.storedGB.toFixed(3)}) exceeds effective allowed GB (${effectiveGB.toFixed(3)})`;
      }
      const uptimeFactor = Math.min(heartbeatCount / MAX_HEARTBEATS_PER_DAY, 1.0);
      const maxAllowed = Math.floor(BASE_STORAGE_RATE_MILLI * effectiveGB * uptimeFactor);
      if (data.amount > maxAllowed) {
        return `storage-reward: amount ${data.amount} exceeds maximum ${maxAllowed} (${effectiveGB.toFixed(3)}GB × ${uptimeFactor.toFixed(2)} uptime)`;
      }
      return null;
    } catch {
      return 'storage-reward: invalid contractData';
    }
  }

  // ── Heartbeat helpers ─────────────────────────────────────────────────────

  /**
   * Return the actual stored GB for a provider in a given epoch, derived from
   * the latest heartbeat block that includes `actualStoredBytes`.
   * Returns 0 if no heartbeat in the epoch reported actual bytes.
   */
  private getActualStoredGBInEpoch(pub: string, epochDay: number): number {
    const chain = this.accountChains.get(pub) || [];
    const epochStart = epochDay * REWARD_EPOCH_MS;
    const epochEnd = epochStart + REWARD_EPOCH_MS;
    let latestBytes = 0;
    let latestTimestamp = 0;
    for (const b of chain) {
      if (b.type !== 'storage-heartbeat' || b.timestamp < epochStart || b.timestamp >= epochEnd) continue;
      if (!b.contractData) continue;
      try {
        const hbData = JSON.parse(b.contractData) as StorageHeartbeatData;
        if (typeof hbData.actualStoredBytes === 'number' && b.timestamp > latestTimestamp) {
          latestBytes = hbData.actualStoredBytes;
          latestTimestamp = b.timestamp;
        }
      } catch { /* skip */ }
    }
    return latestBytes / GB_BYTES;
  }

  /** Count heartbeat blocks in the 24h window ending at refTime */
  private countHeartbeatsLast24h(pub: string, refTime: number): number {
    const chain = this.accountChains.get(pub) || [];
    const cutoff = refTime - 24 * 60 * 60 * 1000;
    return chain.filter(b => b.type === 'storage-heartbeat' && b.timestamp >= cutoff).length;
  }

  /** Count heartbeat blocks in the 24h window for a given epoch day (P3: O(1) via index). */
  countHeartbeatsInEpoch(pub: string, epochDay: number): number {
    return this.heartbeatsByEpoch.get(pub)?.get(epochDay) ?? 0;
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
      // H3: no chain head provided - cannot verify stake, treat as zero (vote is rejected)
      verifiedStake = 0;
    }
    if (verifiedStake <= 0) return;
    this.votes.addVote({ ...vote, stake: verifiedStake });
  }

  processConflicts(): void {
    const { confirmed, rejected } = this.votes.resolveConflicts();
    for (const hash of confirmed) {
      // A2: block transitions from pending to confirmed
      this._confirmedCount++;
      this._pendingCount--;
      this.emit('block:confirmed', this.allBlocks.get(hash));
    }
    for (const hash of rejected) this.handleRejectedBlock(hash);
  }

  private handleRejectedBlock(blockHash: string): void {
    const block = this.allBlocks.get(blockHash);
    if (!block) return;
    // A2: rejected blocks leave the pending pool
    this._pendingCount = Math.max(0, this._pendingCount - 1);
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

  // ── Smart Contracts (sandboxed null-origin iframe) ────────────────────────
  //
  // S2: Uses sandbox="allow-scripts" (no allow-same-origin) to give contracts a
  // null origin, blocking localStorage, cookies, IndexedDB, and cross-origin reads.
  // Blocked network globals (fetch, WebSocket, etc.) are further shadowed by named
  // function parameters so they resolve to undefined inside contract code.
  // The 3-second timeout kills runaway loops at the parent level.

  private static readonly CONTRACT_TIMEOUT_MS = 3000;

  // G3: globals shadowed as undefined-valued named params inside the contract function
  private static readonly BLOCKED_GLOBALS = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'SharedWorker',
    'indexedDB', 'caches', 'navigator', 'location',
    'open', 'close', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'queueMicrotask', 'performance', 'eval', 'Function',
    'Request', 'Response', 'Headers',
    'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader',
    'globalThis', 'self', 'global',
  ] as const;

  private enqueueContractExecution(contractId: string, method: string, args: unknown[], caller: string): void {
    const prev = this.contractQueues.get(contractId) ?? Promise.resolve();
    // A4: defer execution to idle time so contract calls don't block block validation
    const next = prev.then(() => new Promise<void>(resolve => {
      const run = () => this.executeContractSandbox(contractId, method, args, caller).then(resolve);
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => run(), { timeout: 2000 });
      } else {
        setTimeout(run, 0);
      }
    }));
    this.contractQueues.set(contractId, next.catch(() => { /* keep queue alive on error */ }));
  }

  private executeContractSandbox(contractId: string, method: string, args: unknown[], caller: string): Promise<void> {
    const contract = this.contracts.get(contractId);
    if (!contract) return Promise.resolve();
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(method)) return Promise.resolve();
    if (typeof document === 'undefined') return Promise.resolve();

    const blockedNames = DAGLedger.BLOCKED_GLOBALS.join(', ');

    // Build the iframe srcdoc. The script runs in a null-origin context (no same-origin
    // storage/cookie access). Blocked globals are shadowed both via top-level var
    // declarations AND as named function parameters for defence-in-depth.
    // H2: iframe uses e.ports[0] to reply - only our MessageChannel port can receive the result,
    // eliminating the window.addEventListener('message') attack surface.
    const iframeScript = `(function(){
"use strict";
${DAGLedger.BLOCKED_GLOBALS.map(g => `try{Object.defineProperty(window,'${g}',{value:void 0,writable:false,configurable:false})}catch(_){window['${g}']=void 0;}`).join('\n')}
window.addEventListener('message',function(e){
  if(!e.data||e.data.type!=='execute'||!e.ports[0])return;
  var port=e.ports[0];
  var state=e.data.state,caller=e.data.caller,args=e.data.args,method=e.data.method,code=e.data.code;
  try{
    var fn=new Function('state','caller','args',${JSON.stringify(blockedNames)},
      code+'\\nif(typeof '+method+"==='function')return "+method+'(...args);return null;');
    var result=fn(state,caller,args);
    port.postMessage({type:'result',ok:true,result:result,state:state});
  }catch(err){
    port.postMessage({type:'result',ok:false,error:String(err)});
  }
});
})();`;

    return new Promise((resolve) => {
      try {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none;';

        const channel = new MessageChannel();

        const cleanup = () => {
          channel.port1.close();
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        };

        const timeout = setTimeout(() => {
          cleanup();
          this.emit('contract:error', { contractId, method, error: 'Execution timed out' });
          resolve();
        }, DAGLedger.CONTRACT_TIMEOUT_MS);

        channel.port1.onmessage = (e: MessageEvent) => {
          if (!e.data || e.data.type !== 'result') return;
          clearTimeout(timeout);
          cleanup();
          const data = e.data as { ok: boolean; result?: unknown; state?: Record<string, unknown>; error?: string };
          if (data.ok) {
            if (data.state) {
              contract.state = data.state;
              this.emit('contract:state-changed', { contractId, state: data.state });
            }
            this.emit('contract:executed', { contractId, method, result: data.result });
          } else {
            this.emit('contract:error', { contractId, method, error: data.error });
          }
          resolve();
        };

        iframe.srcdoc = `<!DOCTYPE html><html><head><script>${iframeScript.replace(/<\//g, '<\\/')}</script></head><body></body></html>`;
        document.body.appendChild(iframe);

        // Transfer port2 to the iframe so it can reply over the private channel
        iframe.addEventListener('load', () => {
          iframe.contentWindow?.postMessage({
            type: 'execute',
            state: { ...contract.state },
            caller,
            args,
            method,
            code: contract.code,
          }, '*', [channel.port2]);
        }, { once: true });

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
    return {
      network: this.network, totalAccounts: this.accounts.size,
      totalBlocks: this.allBlocks.size, pendingBlocks: this._pendingCount,
      confirmedBlocks: this._confirmedCount, tps: (this.txTimestamps.length / 10).toFixed(1),
    };
  }

  /** A2: Estimate total blockchain size based on block count × average encoded size. */
  estimateBlockchainSizeBytes(): number {
    return this.allBlocks.size * 600;
  }

  getAccountChain(pub: string): AccountBlock[] { return this.accountChains.get(pub) || []; }

  /** P5: Returns the most recent MAX_BLOCKS_DISPLAY blocks without a full sort. */
  getAllBlocks(): AccountBlock[] {
    const start = Math.max(0, this.blockInsertionOrder.length - DAGLedger.MAX_BLOCKS_DISPLAY);
    const result: AccountBlock[] = [];
    for (let i = this.blockInsertionOrder.length - 1; i >= start; i--) {
      const b = this.allBlocks.get(this.blockInsertionOrder[i]);
      if (b) result.push(b);
    }
    return result;
  }

  getBlock(hash: string): AccountBlock | undefined { return this.allBlocks.get(hash); }

  /** A3: Return blocks with timestamp >= cutoff without iterating the entire allBlocks map. */
  getBlocksSince(cutoff: number): AccountBlock[] {
    const result: AccountBlock[] = [];
    for (let i = this.blockInsertionOrder.length - 1; i >= 0; i--) {
      const b = this.allBlocks.get(this.blockInsertionOrder[i]);
      if (!b) continue;
      if (b.timestamp < cutoff) break;
      result.push(b);
    }
    return result;
  }

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

  /**
   * D6: Check whether the network has at least `minCopies` active providers
   * with enough free space to store `fileSizeBytes`.
   * "Active" = heartbeat within the last 24 h.
   * "Free space" = registeredCapacityGB * GB_BYTES − lastActualStoredBytes.
   */
  checkPublishFeasibility(fileSizeBytes: number, minCopies = 2): {
    feasible: boolean;
    providersWithCapacity: number;
    activeProviders: number;
    warning?: string;
  } {
    const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const active = Array.from(this.storageProviders.values()).filter(
      p => p.capacityGB > 0 && p.lastHeartbeat > now - ACTIVE_WINDOW_MS,
    );
    const withSpace = active.filter(p => {
      const freeBytes = p.capacityGB * GB_BYTES - p.lastActualStoredBytes;
      return freeBytes >= fileSizeBytes;
    });
    const feasible = withSpace.length >= minCopies;
    return {
      feasible,
      providersWithCapacity: withSpace.length,
      activeProviders: active.length,
      warning: feasible ? undefined
        : `Only ${withSpace.length} active provider(s) have enough free space (need ≥ ${minCopies} for redundancy). Upload may not be fully replicated.`,
    };
  }

  reset(): void {
    this.accountChains.clear(); this.allBlocks.clear(); this.accounts.clear();
    this.usernameToPublicKey.clear(); this.votes.clear(); this.contracts.clear(); this.contractQueues.clear();
    this.unclaimedSends.clear(); this.faceAccountCount.clear();
    this.storageProviders.clear(); this.heartbeatsByEpoch.clear();
    this.blockInsertionOrder = [];
    this._confirmedCount = 0; this._pendingCount = 0;
    this.txTimestamps = [];
  }
}
