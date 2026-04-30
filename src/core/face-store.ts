/**
 * Face+PIN combined-key encrypted key storage (pinVersion=2).
 *
 * Encryption scheme:
 *   faceBytes  = PBKDF2-SHA256(quantizedDescriptor, "neuronchain-face-v1", 100k)   32 bytes
 *   pinBytes   = PBKDF2-SHA512(pin, pinSalt, 600k)                                 32 bytes
 *   sharedKey  = AES-GCM key derived from XOR(faceBytes, pinBytes)
 *   encryptedKeys = AES-GCM(sharedKey, KeyPairJSON)   ← single layer
 *
 * Both factors are required to derive sharedKey; neither alone can decrypt.
 * The PIN salt and pinVerifier are stored in the blob (enabling UX PIN
 * verification), but the main payload requires the combined key.
 *
 * The blob also carries a face-key-encrypted attempt counter so that
 * exponential backoff state transfers to new devices when the blob is
 * fetched from the libp2p network.
 */

import { KeyPair } from './crypto';
import {
  deriveFaceKey,
  deriveFaceRawBits,
  encryptWithFaceKey,
  decryptWithFaceKey,
  quantizeDescriptor,
  compareFaces,
} from './face-verify';
import { bytesToHex } from './dag-block';
import {
  derivePinKey,
  derivePinRawBits,
  encryptWithPinKey,
  decryptWithPinKey,
  generatePinSalt,
  PinAttemptState,
} from './pin-crypto';

export interface EncryptedKeyBlob {
  /** pinVersion=2: AES-GCM(XOR(faceBytes,pinBytes), KeyPairJSON); pinVersion=0/1: legacy layers */
  encryptedKeys: string;
  /** SHA-256 hash of quantized face descriptor (public reference) */
  faceMapHash: string;
  /** Username */
  username: string;
  /** Account public key */
  pub: string;
  /** Timestamp */
  createdAt: number;
  /** SHA-256(encryptedKeys:faceMapHash:pub) - ties blob to account on-chain */
  linkedAnchor?: string;
  /** base64 32-byte PBKDF2 salt for PIN key derivation */
  pinSalt?: string;
  /** 0 = legacy face-only, 1 = face+PIN two-layer, 2 = face+PIN combined key (current) */
  pinVersion?: number;
  /** face-key-encrypted JSON {failedAttempts, lockedUntil} - tamper-resistant attempt state */
  pinAttemptState?: string;
  /** AES-GCM(pinKey, "PINOK") - allows verifying PIN without decrypting full key blob */
  pinVerifier?: string;
  /**
   * AES-GCM(pinKey, JSON(canonical descriptor)) - the pre-quantization averaged
   * face descriptor, encrypted with the PIN key so recovery is deterministic.
   * Decrypted with PIN → quantize → derive face key (same key as enrollment).
   * Without this field the face key must be derived from the live scan, which
   * is not reliably reproducible across sessions.
   */
  encryptedCanonical?: string;
  /**
   * Unix ms timestamp of the last blob modification.
   * Used to resolve conflicts when multiple nodes gossip the same blob -
   * only the newest version is kept in local IDB.
   */
  updatedAt?: number;
}

// ── Combined key derivation ───────────────────────────────────────────────────

/**
 * Derive an AES-256-GCM key from XOR(faceBytes, pinBytes).
 * Used by both createEncryptedKeyBlob and recoverKeysWithFace for pinVersion=2.
 * Also exported so that main.ts can re-derive the combined key for blob updates
 * (face update, PIN change) without re-running the full recovery flow.
 */
export async function deriveCombinedKey(faceBytes: Uint8Array, pinBytes: Uint8Array): Promise<CryptoKey> {
  const xored = new Uint8Array(32);
  for (let i = 0; i < 32; i++) xored[i] = faceBytes[i] ^ pinBytes[i];
  return crypto.subtle.importKey('raw', xored as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ── linkedAnchor computation ──────────────────────────────────────────────────

async function computeLinkedAnchor(encryptedKeys: string, faceMapHash: string, pub: string): Promise<string> {
  const input = `${encryptedKeys}:${faceMapHash}:${pub}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(buf));
}

// ── Attempt state (stored inside blob, face-key-encrypted) ────────────────────

async function encryptAttemptState(state: Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'>, faceKey: CryptoKey): Promise<string> {
  return encryptWithFaceKey(JSON.stringify(state), faceKey);
}

async function decryptAttemptState(encrypted: string, faceKey: CryptoKey): Promise<Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'> | null> {
  const raw = await decryptWithFaceKey(encrypted, faceKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'>;
  } catch {
    return null;
  }
}

// ── Blob creation ─────────────────────────────────────────────────────────────

/**
 * Create a combined-key encrypted key blob (pinVersion=2).
 *
 * If `pin` is provided:
 *   sharedKey     = AES-GCM(XOR(faceBytes, pinBytes))
 *   encryptedKeys = AES-GCM(sharedKey, KeyPair JSON)   ← single layer, both factors required
 *
 * If `pin` is omitted (legacy face-only path):
 *   encryptedKeys = AES-GCM(face key, KeyPair JSON)
 */
export async function createEncryptedKeyBlob(
  keys: KeyPair,
  username: string,
  canonicalDescriptor: number[],
  faceMapHash: string,
  pin?: string,
): Promise<EncryptedKeyBlob> {
  const quantized = quantizeDescriptor(canonicalDescriptor);
  const faceKey = await deriveFaceKey(quantized, keys.pub);  // used for pinAttemptState
  const keysJson = JSON.stringify(keys);

  let encryptedKeys: string;
  let pinSalt: string | undefined;
  let pinVersion = 0;
  let pinVerifier: string | undefined;
  let encryptedCanonical: string | undefined;

  if (pin !== undefined) {
    const saltBytes = generatePinSalt();
    let binary = '';
    for (let i = 0; i < saltBytes.length; i++) binary += String.fromCharCode(saltBytes[i]);
    pinSalt = btoa(binary);

    // One PBKDF2 call for the PIN - reuse pinBytes for both pinKey and combined key
    const pinBytes = await derivePinRawBits(pin, saltBytes);
    const pinKey = await crypto.subtle.importKey('raw', pinBytes as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

    // Combined key: XOR(faceBytes, pinBytes) - both factors required to decrypt
    const faceBytes = await deriveFaceRawBits(quantized, keys.pub);
    const sharedKey = await deriveCombinedKey(faceBytes, pinBytes);
    encryptedKeys = await encryptWithPinKey(keysJson, sharedKey);  // single layer

    pinVerifier = await encryptWithPinKey('PINOK', pinKey);
    encryptedCanonical = await encryptWithPinKey(JSON.stringify(canonicalDescriptor), pinKey);
    pinVersion = 2;
  } else {
    encryptedKeys = await encryptWithFaceKey(keysJson, faceKey);
  }

  const linkedAnchor = await computeLinkedAnchor(encryptedKeys, faceMapHash, keys.pub);

  const blob: EncryptedKeyBlob = {
    encryptedKeys,
    faceMapHash,
    username,
    pub: keys.pub,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    linkedAnchor,
    pinVersion,
    pinSalt,
    pinVerifier,
    encryptedCanonical,
    pinAttemptState: await encryptAttemptState({ failedAttempts: 0, lockedUntil: 0 }, faceKey),
  };

  return blob;
}

// ── Blob verification ─────────────────────────────────────────────────────────

export async function verifyKeyBlobHash(blob: EncryptedKeyBlob, expectedAnchor: string): Promise<boolean> {
  const computed = await computeLinkedAnchor(blob.encryptedKeys, blob.faceMapHash, blob.pub);
  return computed === expectedAnchor;
}

// ── Attempt state update ──────────────────────────────────────────────────────

/**
 * Re-encrypt the attempt state inside the blob with the face key.
 * Call this after each failed/successful PIN attempt so the state
 * is preserved even when the blob is transferred to a new device.
 */
export async function updateAttemptStateInBlob(
  blob: EncryptedKeyBlob,
  faceKey: CryptoKey,
  state: Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'>,
): Promise<EncryptedKeyBlob> {
  return {
    ...blob,
    updatedAt: Date.now(),
    pinAttemptState: await encryptAttemptState(state, faceKey),
  };
}

// ── Key recovery ──────────────────────────────────────────────────────────────

export interface RecoveryResult {
  keys: KeyPair;
  faceKey: CryptoKey;
  attemptState: Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'>;
}

/**
 * Recover keys from a blob using a face scan and PIN.
 *
 * Supports:
 *   pinVersion=2 (combined key): derives sharedKey = AES(XOR(faceBytes, pinBytes))
 *   pinVersion=1 (two-layer legacy): decrypts PIN outer then face inner
 *   pinVersion=0 (face-only legacy): decrypts with face key only
 *
 * Returns null if decryption fails (wrong face or wrong PIN).
 */
export async function recoverKeysWithFace(
  blob: EncryptedKeyBlob,
  newDescriptor: number[],
  pin?: string,
): Promise<RecoveryResult | null> {
  const quantized = quantizeDescriptor(newDescriptor);
  const faceKey = await deriveFaceKey(quantized, blob.pub);

  // Read embedded attempt state (non-blocking - ignore if missing/corrupted)
  const embeddedState = blob.pinAttemptState
    ? await decryptAttemptState(blob.pinAttemptState, faceKey)
    : null;

  const attemptState = embeddedState ?? { failedAttempts: 0, lockedUntil: 0 };

  // ── Combined-key blob (pinVersion === 2) ───────────────────────────────────
  if (blob.pinVersion === 2) {
    if (!pin || !blob.pinSalt || !blob.encryptedCanonical) return null;

    const saltBytes = Uint8Array.from(atob(blob.pinSalt), c => c.charCodeAt(0));
    // Single PBKDF2 for PIN - reuse bits for both pinVerifier check and combined key
    const pinBytes = await derivePinRawBits(pin, saltBytes);
    const pinKey = await crypto.subtle.importKey('raw', pinBytes as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

    // Quick PIN check via pinVerifier
    if (blob.pinVerifier) {
      const pv = await decryptWithPinKey(blob.pinVerifier, pinKey);
      if (pv !== 'PINOK') return null;
    }

    // Recover stored canonical descriptor (deterministic face key source)
    const canonicalJson = await decryptWithPinKey(blob.encryptedCanonical, pinKey);
    if (!canonicalJson) return null;

    let storedCanonical: number[];
    try { storedCanonical = JSON.parse(canonicalJson) as number[]; } catch { return null; }

    const storedQuantized = quantizeDescriptor(storedCanonical);

    // Biometric verification: live scan must match stored canonical
    if (!compareFaces(storedQuantized, quantizeDescriptor(newDescriptor))) return null;

    // Derive combined key and decrypt
    const faceBytes = await deriveFaceRawBits(storedQuantized, blob.pub);
    const sharedKey = await deriveCombinedKey(faceBytes, pinBytes);
    const decrypted = await decryptWithPinKey(blob.encryptedKeys, sharedKey);
    if (!decrypted) return null;

    let keys: KeyPair;
    try {
      keys = JSON.parse(decrypted) as KeyPair;
      if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) return null;
    } catch { return null; }

    const resolvedFaceKey = await deriveFaceKey(storedQuantized, blob.pub);
    return { keys, faceKey: resolvedFaceKey, attemptState };
  }

  // ── Two-layer blob (pinVersion === 1) ─────────────────────────────────────
  if (blob.pinVersion === 1) {
    if (!pin || !blob.pinSalt) return null;

    const saltBytes = Uint8Array.from(atob(blob.pinSalt), c => c.charCodeAt(0));
    const pinKey = await derivePinKey(pin, saltBytes);

    // Decrypt outer (PIN) layer → intermediate (face-encrypted) ciphertext
    const intermediate = await decryptWithPinKey(blob.encryptedKeys, pinKey);
    if (!intermediate) return null;

    let resolvedFaceKey = faceKey;
    if (blob.encryptedCanonical) {
      const canonicalJson = await decryptWithPinKey(blob.encryptedCanonical, pinKey);
      if (canonicalJson) {
        try {
          const storedCanonical = JSON.parse(canonicalJson) as number[];
          const storedQuantized = quantizeDescriptor(storedCanonical);
          resolvedFaceKey = await deriveFaceKey(storedQuantized, blob.pub);
          if (!compareFaces(storedQuantized, quantizeDescriptor(newDescriptor))) return null;
        } catch { /* fall back to live-scan key */ }
      }
    }

    // Decrypt inner (face) layer → KeyPair JSON
    const decrypted = await decryptWithFaceKey(intermediate, resolvedFaceKey);
    if (!decrypted) return null;

    let keys: KeyPair;
    try {
      keys = JSON.parse(decrypted) as KeyPair;
      if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) return null;
    } catch { return null; }

    return { keys, faceKey: resolvedFaceKey, attemptState };
  }

  // ── Legacy face-only blob (pinVersion === 0) ───────────────────────────────
  const decrypted = await decryptWithFaceKey(blob.encryptedKeys, faceKey);
  if (!decrypted) return null;

  try {
    const keys = JSON.parse(decrypted) as KeyPair;
    if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) return null;
    return { keys, faceKey, attemptState };
  } catch {
    return null;
  }
}
