import { generateKeyPair, KeyPair } from './crypto';

export interface Account {
  username: string;
  pub: string;
  balance: number;
  nonce: number;
  createdAt: number;
  faceMapHash: string;
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
 * before storage — this function only generates the raw keys.
 */
export async function generateAccountKeys(): Promise<KeyPair> {
  return generateKeyPair();
}

/**
 * Build an Account object (without keys — keys are face-locked).
 */
export function buildAccount(
  username: string,
  pub: string,
  faceMapHash: string,
): Account {
  return {
    username,
    pub,
    balance: 0,
    nonce: 0,
    createdAt: Date.now(),
    faceMapHash,
  };
}
