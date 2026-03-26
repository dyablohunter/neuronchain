/**
 * Face-locked key storage.
 *
 * The ECDSA key pair is encrypted with an AES key derived from the
 * face descriptor. The encrypted blob is stored ON-CHAIN via Gun,
 * so it is available for recovery from any device.
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

  return {
    encryptedKeys,
    faceMapHash,
    username,
    pub: keys.pub,
    createdAt: Date.now(),
  };
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
