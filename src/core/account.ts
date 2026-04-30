import { generateKeyPair, KeyPair } from './crypto';

export interface Account {
  username: string;
  pub: string;
  balance: number;
  nonce: number;
  createdAt: number;
  faceMapHash: string;
  /** @deprecated Use encryptedFaceDescriptor. Kept for legacy read compatibility. */
  faceDescriptor?: number[];
  /** Canonical 128-D face descriptor encrypted with the PIN key (privacy-preserving) */
  encryptedFaceDescriptor?: string;
  /** base64 32-byte PBKDF2 salt for PIN key derivation (per-account, public) */
  pinSalt?: string;
  /** SHA-256(encryptedKeys:faceMapHash:pub) - ties the face+PIN blob to this account on-chain */
  linkedAnchor?: string;
  /** ML-DSA-65 public key (base64) - quantum-safe signature verification */
  pqPub?: string;
  /** ML-KEM-768 public key (base64) - quantum-safe key encapsulation */
  pqKemPub?: string;
  /** AES-GCM(pinKey, "PINOK") - used to verify PIN without decrypting the full key blob */
  pinVerifier?: string;
}

export interface AccountWithKeys extends Account {
  keys: KeyPair;
}

export function validateUsername(username: string): { valid: boolean; error?: string } {
  if (username.length < 3 || username.length > 24) {
    return { valid: false, error: 'Username must be 3-24 characters' };
  }
  if (!/^[a-z0-9.]+$/.test(username)) {
    return { valid: false, error: 'Username must be lowercase alphanumeric (a-z, 0-9, .)' };
  }
  return { valid: true };
}

/**
 * Generate a new ECDSA key pair for account creation.
 * The key pair will be encrypted with the face-derived AES key
 * before storage - this function only generates the raw keys.
 */
export async function generateAccountKeys(): Promise<KeyPair> {
  return generateKeyPair();
}

export interface AccountExtras {
  encryptedFaceDescriptor?: string;
  pinSalt?: string;
  pinVerifier?: string;
  linkedAnchor?: string;
  pqPub?: string;
  pqKemPub?: string;
}

/**
 * Build an Account object (without keys - keys are face+PIN locked).
 */
export function buildAccount(
  username: string,
  pub: string,
  faceMapHash: string,
  extras: AccountExtras = {},
): Account {
  return {
    username,
    pub,
    balance: 0,
    nonce: 0,
    createdAt: Date.now(),
    faceMapHash,
    ...extras,
  };
}
