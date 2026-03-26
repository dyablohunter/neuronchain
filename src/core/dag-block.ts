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

export const VERIFICATION_MINT_AMOUNT = 1_000_000;

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
 * Compute a deterministic hash for a block.
 * Sync for speed — uses the same approach as checkpoint blocks.
 */
export function hashAccountBlock(block: Omit<AccountBlock, 'hash' | 'signature'>): string {
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

  // Deterministic sync hash → 64 hex chars
  let h1 = 0, h2 = 0, h3 = 0, h4 = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    h1 = ((h1 << 5) - h1 + c) | 0;
    h2 = ((h2 << 7) - h2 + c) | 0;
    h3 = ((h3 << 11) - h3 + c) | 0;
    h4 = ((h4 << 13) - h4 + c) | 0;
  }
  const seg = (v: number) => Math.abs(v).toString(16).padStart(8, '0');
  let result = seg(h1) + seg(h2) + seg(h3) + seg(h4);
  // Extend to 64 chars
  for (let i = 0; i < 4; i++) {
    let h = h1 + h2 * (i + 1) + h3 * (i + 2) + h4 * (i + 3);
    for (let j = 0; j < 8; j++) {
      h = ((h << 5) - h + data.charCodeAt((i * 8 + j) % data.length)) | 0;
    }
    result += seg(h);
  }
  return result.slice(0, 64);
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
  const hash = hashAccountBlock(hashInput);
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
      if (parent.balance < block.amount) return { valid: false, error: 'Insufficient balance' };
      if (block.balance !== parent.balance - block.amount) return { valid: false, error: 'Balance mismatch after send' };
      return { valid: true };
    }
    case 'receive': {
      if (!block.sendBlockHash) return { valid: false, error: 'Receive block needs sendBlockHash' };
      if (!block.receiveAmount || block.receiveAmount <= 0) return { valid: false, error: 'Receive amount must be positive' };
      if (block.balance !== parent.balance + block.receiveAmount) return { valid: false, error: 'Balance mismatch after receive' };
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
