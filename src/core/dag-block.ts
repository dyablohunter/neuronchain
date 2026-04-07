import { signData, verifySignature, KeyPair } from './crypto';

/**
 * Block types in the block-lattice:
 *
 * Core ledger:
 * - open:              First block — FaceID verified, mints 1,000,000 UNIT
 * - send:              Transfer UNIT to another account (deducts from sender)
 * - receive:           Accept UNIT from a confirmed send block (credits recipient)
 * - deploy:            Deploy a smart contract
 * - call:              Call a smart contract method
 *
 * Decentralised storage ledger:
 * - storage-register:    Register as a storage provider (capacityGB > 0) or adjust capacity
 * - storage-deregister:  Leave the storage ledger entirely
 * - storage-heartbeat:   Periodic proof-of-uptime block (every ~4h) — used to validate reward amounts
 * - storage-reward:      Daily self-issued block — mints new UNIT proportional to stored GB × uptime factor
 */
export type AccountBlockType =
  | 'open' | 'send' | 'receive' | 'deploy' | 'call'
  | 'storage-register' | 'storage-deregister' | 'storage-heartbeat' | 'storage-reward';

export const UNIT_DECIMALS = 3;
export const UNIT_FACTOR = 1000;
export const VERIFICATION_MINT_AMOUNT = 1_000_000 * UNIT_FACTOR;

/** Base earning rate: 1 UNIT per GB per day (in milli-UNIT) */
export const BASE_STORAGE_RATE_MILLI = 1_000;
/** Maximum on-chain heartbeat blocks expected per day (one every ~4 hours) */
export const MAX_HEARTBEATS_PER_DAY = 6;
/** Minimum interval between consecutive heartbeat blocks in ms (4 hours) */
export const HEARTBEAT_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Reward epoch duration in ms (24 hours) */
export const REWARD_EPOCH_MS = 24 * 60 * 60 * 1000;

export function formatUNIT(milliUnits: number): string {
  const whole = Math.floor(milliUnits / UNIT_FACTOR);
  const frac = milliUnits % UNIT_FACTOR;
  if (frac === 0) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(UNIT_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toLocaleString()}.${fracStr}`;
}

export function parseUNIT(input: string): number {
  const parts = input.trim().split('.');
  const whole = parseInt(parts[0] || '0', 10) || 0;
  let frac = 0;
  if (parts[1]) {
    const fracStr = parts[1].slice(0, UNIT_DECIMALS).padEnd(UNIT_DECIMALS, '0');
    frac = parseInt(fracStr, 10) || 0;
  }
  return whole * UNIT_FACTOR + frac;
}

export type ConfirmationStatus = 'pending' | 'voting' | 'confirmed' | 'rejected';

export interface AccountBlock {
  hash: string;
  accountPub: string;
  index: number;
  type: AccountBlockType;
  previousHash: string;
  balance: number;
  timestamp: number;
  signature: string;

  // send fields
  recipient?: string;
  amount?: number;

  // receive fields
  sendBlockHash?: string;
  sendFrom?: string;
  receiveAmount?: number;

  // verify fields
  faceMapHash?: string;

  // contract + storage fields (JSON-encoded payload)
  contractData?: string;

  /**
   * IPFS CID of content referenced or produced by this block.
   * Used by social app posts, NFT media, etc.
   */
  contentCid?: string;
}

export interface ConfirmedBlock extends AccountBlock {
  status: ConfirmationStatus;
  confirmedAt?: number;
  totalApproveStake: number;
  totalRejectStake: number;
}

// ── Storage ledger payloads ───────────────────────────────────────────────────

/** Payload for storage-register block */
export interface StorageRegisterData {
  type: 'storage-register';
  /** Offered capacity in gigabytes. Set to 0 to deregister. */
  capacityGB: number;
}

/**
 * Payload for storage-reward block.
 * The provider self-issues this once per day. Other nodes verify the amount
 * against on-chain heartbeat count and registered capacity.
 */
export interface StorageRewardData {
  type: 'storage-reward';
  /** Day index = Math.floor(Date.now() / REWARD_EPOCH_MS) */
  epochDay: number;
  /** Registered capacity in GB at reward time (must match latest storage-register) */
  storedGB: number;
  /** On-chain heartbeat blocks counted in this epoch's 24h window */
  heartbeatCount: number;
  /** milli-UNIT being minted into the provider's balance */
  amount: number;
}

// ── Block hashing ─────────────────────────────────────────────────────────────

export async function hashAccountBlock(block: Omit<AccountBlock, 'hash' | 'signature'>): Promise<string> {
  const data = [
    block.accountPub,
    block.index,
    block.type,
    block.previousHash,
    block.balance,
    block.timestamp,
    block.recipient || '',
    block.amount ?? '',
    block.sendBlockHash || '',
    block.sendFrom || '',
    block.receiveAmount ?? '',
    block.faceMapHash || '',
    block.contractData || '',
    block.contentCid || '',
  ].join(':');

  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function createAccountBlock(
  params: {
    accountPub: string;
    index: number;
    type: AccountBlockType;
    previousHash: string;
    balance: number;
    recipient?: string;
    amount?: number;
    sendBlockHash?: string;
    sendFrom?: string;
    receiveAmount?: number;
    faceMapHash?: string;
    contractData?: string;
    contentCid?: string;
  },
  keys: KeyPair,
): Promise<AccountBlock> {
  const timestamp = Date.now();
  const hashInput = { ...params, timestamp };
  const hash = await hashAccountBlock(hashInput);
  const signature = await signData(hash, keys);
  return { ...params, timestamp, hash, signature };
}

export async function verifyBlockSignature(block: AccountBlock): Promise<boolean> {
  const result = await verifySignature(block.signature, block.accountPub);
  return result === block.hash;
}

export function validateBlockStructure(
  block: AccountBlock,
  parent: AccountBlock | null,
): { valid: boolean; error?: string } {
  if (!Number.isSafeInteger(block.balance) || block.balance < 0) {
    return { valid: false, error: 'Balance out of safe integer range' };
  }

  if (block.type === 'open') {
    if (parent !== null) return { valid: false, error: 'Open block cannot have a parent' };
    if (block.index !== 0) return { valid: false, error: 'Open block must be index 0' };
    if (!block.faceMapHash) return { valid: false, error: 'Open block requires faceMapHash' };
    if (block.balance !== VERIFICATION_MINT_AMOUNT) return { valid: false, error: `Open block must mint ${VERIFICATION_MINT_AMOUNT} UNIT` };
    if (block.previousHash !== '0'.repeat(64)) return { valid: false, error: 'Open block previousHash must be zero' };
    return { valid: true };
  }

  if (!parent) return { valid: false, error: 'Non-open block requires a parent' };
  if (block.previousHash !== parent.hash) return { valid: false, error: 'previousHash mismatch' };
  if (block.index !== parent.index + 1) return { valid: false, error: 'Index must be parent + 1' };

  switch (block.type) {
    case 'send': {
      if (!block.recipient) return { valid: false, error: 'Send block needs recipient' };
      if (!block.amount || block.amount <= 0) return { valid: false, error: 'Send amount must be positive' };
      if (!Number.isSafeInteger(block.amount)) return { valid: false, error: 'Send amount out of safe integer range' };
      if (parent.balance < block.amount) return { valid: false, error: 'Insufficient balance' };
      if (block.balance !== parent.balance - block.amount) return { valid: false, error: 'Balance mismatch after send' };
      return { valid: true };
    }
    case 'receive': {
      if (!block.sendBlockHash) return { valid: false, error: 'Receive block needs sendBlockHash' };
      if (!block.receiveAmount || block.receiveAmount <= 0) return { valid: false, error: 'Receive amount must be positive' };
      if (!Number.isSafeInteger(block.receiveAmount)) return { valid: false, error: 'Receive amount out of safe integer range' };
      const newBalance = parent.balance + block.receiveAmount;
      if (!Number.isSafeInteger(newBalance)) return { valid: false, error: 'Resulting balance would overflow safe integer range' };
      if (block.balance !== newBalance) return { valid: false, error: 'Balance mismatch after receive' };
      return { valid: true };
    }
    case 'deploy': {
      if (!block.contractData) return { valid: false, error: 'Deploy block needs contractData' };
      if (block.balance !== parent.balance) return { valid: false, error: 'Balance unchanged after deploy' };
      return { valid: true };
    }
    case 'call': {
      if (!block.contractData) return { valid: false, error: 'Call block needs contractData' };
      if (block.balance !== parent.balance) return { valid: false, error: 'Balance unchanged after call' };
      return { valid: true };
    }
    case 'storage-register': {
      if (!block.contractData) return { valid: false, error: 'storage-register block needs contractData' };
      try {
        const data = JSON.parse(block.contractData) as StorageRegisterData;
        if (typeof data.capacityGB !== 'number' || data.capacityGB <= 0) {
          return { valid: false, error: 'capacityGB must be a positive number' };
        }
      } catch {
        return { valid: false, error: 'storage-register contractData is not valid JSON' };
      }
      if (block.balance !== parent.balance) return { valid: false, error: 'Balance unchanged for storage-register' };
      return { valid: true };
    }
    case 'storage-deregister': {
      if (block.balance !== parent.balance) return { valid: false, error: 'Balance unchanged for storage-deregister' };
      return { valid: true };
    }
    case 'storage-heartbeat': {
      if (block.balance !== parent.balance) return { valid: false, error: 'Balance unchanged for storage-heartbeat' };
      // Minimum interval enforcement: timestamp must be >= parent's timestamp + some buffer
      // (Full interval check against the last heartbeat block is done in DAGLedger.addBlock)
      return { valid: true };
    }
    case 'storage-reward': {
      if (!block.contractData) return { valid: false, error: 'storage-reward block needs contractData' };
      try {
        const data = JSON.parse(block.contractData) as StorageRewardData;
        if (!Number.isSafeInteger(data.amount) || data.amount <= 0) {
          return { valid: false, error: 'Reward amount must be a positive integer' };
        }
        if (typeof data.epochDay !== 'number' || data.epochDay <= 0) {
          return { valid: false, error: 'Invalid epochDay' };
        }
        if (typeof data.storedGB !== 'number' || data.storedGB <= 0) {
          return { valid: false, error: 'storedGB must be positive' };
        }
        const newBalance = parent.balance + data.amount;
        if (!Number.isSafeInteger(newBalance)) {
          return { valid: false, error: 'Reward would overflow safe integer balance' };
        }
        if (block.balance !== newBalance) {
          return { valid: false, error: 'Balance mismatch: expected parent.balance + amount' };
        }
      } catch {
        return { valid: false, error: 'storage-reward contractData is not valid JSON' };
      }
      return { valid: true };
    }
  }

  return { valid: false, error: 'Unknown block type' };
}
