/**
 * PIN-based second-factor cryptography.
 *
 * Provides:
 *  - PBKDF2-SHA-512 key derivation from a 4-digit PIN (600,000 iterations)
 *  - AES-256-GCM encrypt/decrypt with the derived key
 *  - Per-account exponential backoff attempt tracking via IndexedDB
 *  - LockoutNotice type for GossipSub broadcast
 *
 * Self-contained: no imports from the network layer.
 */

import { openDB } from 'idb';

// ── Constants ──────────────────────────────────────────────────────────────────

const DB_NAME = 'neuronchain-security';
const STORE_NAME = 'pinAttempts';
const KDF_ITERATIONS = 600_000;

// Backoff schedule: attempts > 3 get exponential delay (seconds)
// delay_s = Math.min(86400, 30 * 4^(attempt-3))
const MAX_DELAY_MS = 86_400_000; // 24 hours
const FREE_ATTEMPTS = 3;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PinAttemptState {
  accountPub: string;
  failedAttempts: number;
  lockedUntil: number; // unix ms, 0 = not locked
  lastAttemptAt: number;
}

export interface LockoutNotice {
  accountPub: string;
  failedAttempts: number;
  lockedUntil: number;
  timestamp: number;
  /** ECDSA signature by accountPub over `lockout:{accountPub}:{failedAttempts}:{lockedUntil}:{timestamp}` */
  signature?: string;
}

/** Canonical payload signed inside a LockoutNotice. */
export function lockoutPayload(n: LockoutNotice): string {
  return `lockout:${n.accountPub}:${n.failedAttempts}:${n.lockedUntil}:${n.timestamp}`;
}

// ── Database ───────────────────────────────────────────────────────────────────

async function getDB() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'accountPub' });
      }
    },
  });
}

// ── Backoff schedule ──────────────────────────────────────────────────────────

export function getBackoffMs(failedAttempts: number): number {
  if (failedAttempts <= FREE_ATTEMPTS) return 0;
  const delaySec = 30 * Math.pow(4, failedAttempts - FREE_ATTEMPTS - 1);
  return Math.min(MAX_DELAY_MS, Math.round(delaySec * 1000));
}

// ── Attempt tracking ──────────────────────────────────────────────────────────

export async function getPinAttemptState(accountPub: string): Promise<PinAttemptState> {
  const db = await getDB();
  const existing = await db.get(STORE_NAME, accountPub);
  return existing ?? { accountPub, failedAttempts: 0, lockedUntil: 0, lastAttemptAt: 0 };
}

export async function checkPinLockout(
  accountPub: string,
): Promise<{ locked: boolean; remainingMs: number }> {
  const state = await getPinAttemptState(accountPub);
  const now = Date.now();
  if (state.lockedUntil > now) {
    return { locked: true, remainingMs: state.lockedUntil - now };
  }
  return { locked: false, remainingMs: 0 };
}

export async function recordPinFailure(accountPub: string): Promise<PinAttemptState> {
  const db = await getDB();
  const state = await getPinAttemptState(accountPub);
  const next: PinAttemptState = {
    accountPub,
    failedAttempts: state.failedAttempts + 1,
    lockedUntil: Date.now() + getBackoffMs(state.failedAttempts + 1),
    lastAttemptAt: Date.now(),
  };
  await db.put(STORE_NAME, next);
  return next;
}

export async function recordPinSuccess(accountPub: string): Promise<void> {
  const db = await getDB();
  const reset: PinAttemptState = {
    accountPub,
    failedAttempts: 0,
    lockedUntil: 0,
    lastAttemptAt: Date.now(),
  };
  await db.put(STORE_NAME, reset);
}

// ── PIN key derivation ─────────────────────────────────────────────────────────

export function generatePinSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Derive 32 raw bytes from a PIN using PBKDF2-SHA-512 (600k iterations).
 * Used to construct combined face+PIN keys via XOR. Same KDF parameters as
 * derivePinKey so the two derivations are cryptographically equivalent.
 */
export async function derivePinRawBits(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(pin);
  const keyMaterial = await crypto.subtle.importKey('raw', encoded, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: KDF_ITERATIONS, hash: 'SHA-512' },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Derive an AES-256-GCM key from a PIN using PBKDF2-SHA-512.
 * 600,000 iterations per OWASP 2024 recommendation for PBKDF2-SHA-512.
 * Each guess takes ~300ms in browser, making offline brute force over 10,000 PINs
 * take ~50 minutes minimum without hardware acceleration.
 */
export async function derivePinKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoded = new TextEncoder().encode(pin);
  const keyMaterial = await crypto.subtle.importKey('raw', encoded, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: KDF_ITERATIONS, hash: 'SHA-512' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── PIN AES-256-GCM encrypt / decrypt ─────────────────────────────────────────

/**
 * Encrypt a UTF-8 string with the PIN-derived AES-256-GCM key.
 * Returns base64(IV || ciphertext).
 */
export async function encryptWithPinKey(data: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ct), 12);
  let binary = '';
  for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

/**
 * Decrypt a string produced by encryptWithPinKey.
 * Returns null if decryption fails (wrong PIN / corrupted data).
 */
export async function decryptWithPinKey(encrypted: string, key: CryptoKey): Promise<string | null> {
  try {
    const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
