/**
 * Face-locked key storage.
 *
 * The ECDSA key pair is encrypted with an AES key derived from the
 * face descriptor. The encrypted blob is stored on the libp2p network
 * + IndexedDB, so it is available for recovery from any device.
 *
 * Only the person whose face matches can decrypt the keys.
 */

import { KeyPair } from './crypto';
import {
  deriveFaceKey,
  encryptWithFaceKey,
  decryptWithFaceKey,
  quantizeDescriptor,
} from './face-verify';

export interface EncryptedKeyBlob {
  /** The encrypted ECDSA key pair JSON */
  encryptedKeys: string;
  /** SHA-256 hash of the quantized face descriptor (public reference) */
  faceMapHash: string;
  /** Username */
  username: string;
  /** Account public key */
  pub: string;
  /** Timestamp */
  createdAt: number;
  /** SHA-256 hash of the blob contents — stored on-chain for verification */
  blobHash?: string;
}

/**
 * Encrypt a key pair using a face descriptor.
 * Returns the encrypted blob ready for on-chain storage.
 */
export async function createEncryptedKeyBlob(
  keys: KeyPair,
  username: string,
  quantizedDescriptor: number[],
  faceMapHash: string,
): Promise<EncryptedKeyBlob> {
  const faceKey = await deriveFaceKey(quantizedDescriptor);
  const keysJson = JSON.stringify(keys);
  const encryptedKeys = await encryptWithFaceKey(keysJson, faceKey);

  // Compute content hash for on-chain verification
  const hashInput = `${encryptedKeys}:${faceMapHash}:${keys.pub}`;
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput));
  const blobHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    encryptedKeys,
    faceMapHash,
    username,
    pub: keys.pub,
    createdAt: Date.now(),
    blobHash,
  };
}

/** Verify a key blob's content hash matches the expected hash from on-chain account data */
export function verifyKeyBlobHash(blob: EncryptedKeyBlob, expectedHash: string): Promise<boolean> {
  const hashInput = `${blob.encryptedKeys}:${blob.faceMapHash}:${blob.pub}`;
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashInput)).then(buf => {
    const computed = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return computed === expectedHash;
  });
}

/**
 * Recover a key pair by decrypting with a new face scan.
 * Returns the key pair if the face matches, null otherwise.
 */
export async function recoverKeysWithFace(
  blob: EncryptedKeyBlob,
  newDescriptor: number[],
): Promise<KeyPair | null> {
  const quantized = quantizeDescriptor(newDescriptor);
  const faceKey = await deriveFaceKey(quantized);
  const decrypted = await decryptWithFaceKey(blob.encryptedKeys, faceKey);
  if (!decrypted) return null;

  try {
    const keys = JSON.parse(decrypted) as KeyPair;
    if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) return null;
    return keys;
  } catch {
    return null;
  }
}
