import { signData, verifySignature, KeyPair } from './crypto';

/**
 * Block types in the block-lattice:
 *
 * - open:    First block — FaceID verified, mints 1,000,000 UNIT
 * - send:    Transfer UNIT to another account (deducts from sender)
 * - receive: Accept UNIT from a confirmed send block (credits recipient)
 * - deploy:  Deploy a smart contract
 * - call:    Call a smart contract method
 */
export type AccountBlockType = 'open' | 'send' | 'receive' | 'deploy' | 'call';

/**
 * 18 decimal places — all balances/amounts use BigInt internally
 * to avoid floating-point precision loss (10^18 > Number.MAX_SAFE_INTEGER).
 *
 * However, Gun.js and the rest of the system pass numbers around,
 * so we store as strings in serialization and convert at boundaries.
 * For simplicity in the current system, we use a scaled integer approach:
 * amounts are stored as regular numbers representing WHOLE UNIT values,
 * and sub-UNIT amounts use 3 decimal digits (milli-UNIT precision).
 *
 * Internal storage: amount * 1000 (milli-UNIT integer)
 * Display: amount / 1000 with up to 3 decimal places
 */
export const UNIT_DECIMALS = 3;
export const UNIT_FACTOR = 1000; // 1 UNIT = 1000 milli-UNIT
export const VERIFICATION_MINT_AMOUNT = 1_000_000 * UNIT_FACTOR; // 1M UNIT in milli-UNIT

/** Convert milli-UNIT integer to display string */
export function formatUNIT(milliUnits: number): string {
  const whole = Math.floor(milliUnits / UNIT_FACTOR);
  const frac = milliUnits % UNIT_FACTOR;
  if (frac === 0) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(UNIT_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toLocaleString()}.${fracStr}`;
}

/** Parse a user-input UNIT string to milli-UNIT integer */
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

  // contract fields
  contractData?: string;
}

export interface ConfirmedBlock extends AccountBlock {
  status: ConfirmationStatus;
  confirmedAt?: number;
  totalApproveStake: number;
  totalRejectStake: number;
}

/**
 * Compute a deterministic SHA-256 hash for a block.
 * Returns a 64-char hex string.
 */
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
  ].join(':');

  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create and sign an account block.
 */
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
  },
  keys: KeyPair,
): Promise<AccountBlock> {
  const timestamp = Date.now();
  const hashInput = { ...params, timestamp };
  const hash = await hashAccountBlock(hashInput);
  const signature = await signData(hash, keys);

  return {
    ...params,
    timestamp,
    hash,
    signature,
  };
}

/**
 * Verify a block's signature matches its claimed author.
 */
export async function verifyBlockSignature(block: AccountBlock): Promise<boolean> {
  const result = await verifySignature(block.signature, block.accountPub);
  return result === block.hash;
}

/**
 * Validate structural integrity of a block against its parent.
 */
export function validateBlockStructure(
  block: AccountBlock,
  parent: AccountBlock | null,
): { valid: boolean; error?: string } {
  // Reject any block with a balance that exceeds safe integer range
  if (!Number.isSafeInteger(block.balance) || block.balance < 0) {
    return { valid: false, error: 'Balance out of safe integer range' };
  }

  if (block.type === 'open') {
    if (parent !== null) return { valid: false, error: 'Open block cannot have a parent' };
    if (block.index !== 0) return { valid: false, error: 'Open block must be index 0' };
    if (!block.faceMapHash) return { valid: false, error: 'Open block requires faceMapHash (FaceID mandatory)' };
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
      if (block.balance !== parent.balance) return { valid: false, error: 'Balance mismatch after deploy' };
      return { valid: true };
    }
    case 'call': {
      if (!block.contractData) return { valid: false, error: 'Call block needs contractData' };
      if (block.balance !== parent.balance) return { valid: false, error: 'Balance mismatch after call' };
      return { valid: true };
    }
  }

  return { valid: false, error: 'Unknown block type' };
}
