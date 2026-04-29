/**
 * Face+PIN double-encrypted key storage.
 *
 * Encryption layers (inner → outer):
 *   1. AES-256-GCM keyed by face-derived PBKDF2 key  (face factor)
 *   2. AES-256-GCM keyed by PIN-derived PBKDF2 key   (PIN factor)
 *
 * Both factors are required to recover keys. The PIN salt is public
 * (stored in the blob), the face descriptor is never stored in plaintext.
 *
 * The blob also carries a face-key-encrypted attempt counter so that
 * exponential backoff state transfers to new devices when the blob is
 * fetched from the libp2p network.
 */

import { KeyPair } from './crypto';
import {
  deriveFaceKey,
  encryptWithFaceKey,
  decryptWithFaceKey,
  quantizeDescriptor,
  compareFaces,
} from './face-verify';
import {
  derivePinKey,
  encryptWithPinKey,
  decryptWithPinKey,
  generatePinSalt,
  PinAttemptState,
} from './pin-crypto';

export interface EncryptedKeyBlob {
  /** Double-encrypted key pair: AES-GCM(PIN key, AES-GCM(face key, KeyPair JSON)) */
  encryptedKeys: string;
  /** SHA-256 hash of quantized face descriptor (public reference) */
  faceMapHash: string;
  /** Username */
  username: string;
  /** Account public key */
  pub: string;
  /** Timestamp */
  createdAt: number;
  /** SHA-256(encryptedKeys:faceMapHash:pub) — ties blob to account on-chain */
  linkedAnchor?: string;
  /** base64 32-byte PBKDF2 salt for PIN key derivation */
  pinSalt?: string;
  /** 0 = legacy face-only, 1 = face+PIN double-encrypted */
  pinVersion?: number;
  /** face-key-encrypted JSON {failedAttempts, lockedUntil} — tamper-resistant attempt state */
  pinAttemptState?: string;
  /** AES-GCM(pinKey, "PINOK") — allows verifying PIN without decrypting full key blob */
  pinVerifier?: string;
  /**
   * AES-GCM(pinKey, JSON(canonical descriptor)) — the pre-quantization averaged
   * face descriptor, encrypted with the PIN key so recovery is deterministic.
   * Decrypted with PIN → quantize → derive face key (same key as enrollment).
   * Without this field the face key must be derived from the live scan, which
   * is not reliably reproducible across sessions.
   */
  encryptedCanonical?: string;
  /**
   * Unix ms timestamp of the last blob modification.
   * Used to resolve conflicts when multiple nodes gossip the same blob —
   * only the newest version is kept in local IDB.
   */
  updatedAt?: number;
}

// ── linkedAnchor computation ──────────────────────────────────────────────────

async function computeLinkedAnchor(encryptedKeys: string, faceMapHash: string, pub: string): Promise<string> {
  const input = `${encryptedKeys}:${faceMapHash}:${pub}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
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
 * Create a double-encrypted key blob.
 *
 * If `pin` is provided (required for new accounts):
 *   encryptedKeys = AES-GCM(PIN key, AES-GCM(face key, KeyPair JSON))
 *
 * If `pin` is omitted (legacy path only):
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
  const faceKey = await deriveFaceKey(quantized);
  const keysJson = JSON.stringify(keys);
  const innerEncrypted = await encryptWithFaceKey(keysJson, faceKey);

  let encryptedKeys = innerEncrypted;
  let pinSalt: string | undefined;
  let pinVersion = 0;
  let pinVerifier: string | undefined;
  let encryptedCanonical: string | undefined;

  if (pin !== undefined) {
    const saltBytes = generatePinSalt();
    pinSalt = btoa(String.fromCharCode(...saltBytes));
    const pinKey = await derivePinKey(pin, saltBytes);
    encryptedKeys = await encryptWithPinKey(innerEncrypted, pinKey);
    pinVerifier = await encryptWithPinKey('PINOK', pinKey);
    // Store canonical encrypted with PIN key so recovery is deterministic
    // (face key is derived from stored canonical, not from live scan)
    encryptedCanonical = await encryptWithPinKey(JSON.stringify(canonicalDescriptor), pinKey);
    pinVersion = 1;
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
 * Recover keys from a blob using a face scan (and PIN if blob.pinVersion === 1).
 *
 * Returns the recovered key pair along with the derived face key (for subsequent
 * blob updates) and the current attempt state.
 *
 * Returns null if decryption fails (wrong face or wrong PIN).
 * On wrong PIN the caller should call updateAttemptStateInBlob and re-publish the blob.
 */
export async function recoverKeysWithFace(
  blob: EncryptedKeyBlob,
  newDescriptor: number[],
  pin?: string,
): Promise<RecoveryResult | null> {
  const quantized = quantizeDescriptor(newDescriptor);
  const faceKey = await deriveFaceKey(quantized);

  // Read embedded attempt state (non-blocking — ignore if missing/corrupted)
  const embeddedState = blob.pinAttemptState
    ? await decryptAttemptState(blob.pinAttemptState, faceKey)
    : null;

  const attemptState = embeddedState ?? { failedAttempts: 0, lockedUntil: 0 };

  // ── PIN-protected blob (pinVersion === 1) ──────────────────────────────────
  if (blob.pinVersion === 1) {
    if (!pin || !blob.pinSalt) return null;

    const saltBytes = Uint8Array.from(atob(blob.pinSalt), c => c.charCodeAt(0));
    const pinKey = await derivePinKey(pin, saltBytes);

    // Decrypt outer (PIN) layer → intermediate (face-encrypted) ciphertext
    const intermediate = await decryptWithPinKey(blob.encryptedKeys, pinKey);
    if (!intermediate) return null; // Wrong PIN

    // Determine the face key to use for inner decryption.
    // If encryptedCanonical is present (new blobs), decrypt it with the PIN key to
    // get the original enrollment canonical descriptor, then derive the face key from
    // that stored canonical — this is deterministic regardless of live-scan variance.
    // Fall back to the live-scan-derived key for legacy blobs.
    let resolvedFaceKey = faceKey;
    if (blob.encryptedCanonical) {
      const canonicalJson = await decryptWithPinKey(blob.encryptedCanonical, pinKey);
      if (canonicalJson) {
        try {
          const storedCanonical = JSON.parse(canonicalJson) as number[];
          const storedQuantized = quantizeDescriptor(storedCanonical);
          resolvedFaceKey = await deriveFaceKey(storedQuantized);

          // Biometric verification: live scan must be close to stored canonical
          const liveQuantized = quantizeDescriptor(newDescriptor);
          if (!compareFaces(storedQuantized, liveQuantized)) return null;
        } catch {
          // Corrupted canonical — fall back to live-scan key
        }
      }
    }

    // Decrypt inner (face) layer → KeyPair JSON
    const decrypted = await decryptWithFaceKey(intermediate, resolvedFaceKey);
    if (!decrypted) return null; // Wrong face

    let keys: KeyPair;
    try {
      keys = JSON.parse(decrypted) as KeyPair;
      if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) return null;
    } catch {
      return null;
    }

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
