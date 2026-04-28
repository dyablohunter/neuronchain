/**
 * Cryptographic primitives.
 *
 * Classical: Web Crypto API (ECDSA P-256 signing, ECDH P-256 encryption).
 * Quantum-safe: @noble/post-quantum (ML-DSA-65 hybrid signing, ML-KEM-768 key encapsulation).
 *
 * Classical key wire format: base64-encoded JWK JSON strings.
 * PQ key wire format: base64-encoded raw Uint8Array.
 * Signature wire format: JSON string `{"d":"<original-data>","s":"<base64-sig>"}`
 */

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

export interface KeyPair {
  pub: string;   // ECDSA P-256 public key  - base64(JSON(JWK))
  priv: string;  // ECDSA P-256 private key - base64(JSON(JWK))
  epub: string;  // ECDH  P-256 public key  - base64(JSON(JWK))
  epriv: string; // ECDH  P-256 private key - base64(JSON(JWK))
  // Quantum-safe keys (absent on legacy accounts)
  pqPub?: string;     // ML-DSA-65 public key  - base64(Uint8Array, 1952 bytes)
  pqPriv?: string;    // ML-DSA-65 private key - base64(Uint8Array, 4032 bytes)
  pqKemPub?: string;  // ML-KEM-768 public key  - base64(Uint8Array, 1184 bytes)
  pqKemPriv?: string; // ML-KEM-768 private key - base64(Uint8Array, 2400 bytes)
}

// ── Byte helpers ──────────────────────────────────────────────────────────────

function bufToB64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64ToBuf(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

async function exportJWK(key: CryptoKey): Promise<string> {
  return btoa(JSON.stringify(await crypto.subtle.exportKey('jwk', key)));
}

// ── Key import helpers ────────────────────────────────────────────────────────

async function importSignPriv(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk', JSON.parse(atob(b64)),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
}

async function importVerifyPub(b64: string): Promise<CryptoKey> {
  // Strip private scalar (d) if present - public-key-only import
  const jwk = JSON.parse(atob(b64)) as Record<string, unknown>;
  const { d: _ignored, key_ops: _ko, ...pubJwk } = jwk;
  void _ignored; void _ko;
  return crypto.subtle.importKey(
    'jwk', { ...pubJwk, key_ops: ['verify'] },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  );
}

async function importECDHPriv(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk', JSON.parse(atob(b64)),
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'],
  );
}

// ── AES key derived from ECDH private key scalar via PBKDF2 ──────────────────

async function deriveAESFromECDH(eprivB64: string): Promise<CryptoKey> {
  const jwk = JSON.parse(atob(eprivB64)) as { d?: string };
  // `d` is the raw base64url-encoded private scalar
  const raw = new TextEncoder().encode(jwk.d ?? eprivB64);
  const baseKey = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode('neuronchain-v2'),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Generate a fresh ECDSA/ECDH P-256 key pair with ML-DSA-65 and ML-KEM-768 quantum-safe keys */
export async function generateKeyPair(): Promise<KeyPair> {
  const [sigPair, encPair] = await Promise.all([
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']),
    crypto.subtle.generateKey({ name: 'ECDH',  namedCurve: 'P-256' }, true, ['deriveKey']),
  ]);
  const [pub, priv, epub, epriv] = await Promise.all([
    exportJWK((sigPair as CryptoKeyPair).publicKey),
    exportJWK((sigPair as CryptoKeyPair).privateKey),
    exportJWK((encPair as CryptoKeyPair).publicKey),
    exportJWK((encPair as CryptoKeyPair).privateKey),
  ]);

  const dsaKeys = ml_dsa65.keygen();
  const kemKeys = ml_kem768.keygen();

  return {
    pub, priv, epub, epriv,
    pqPub:    btoa(String.fromCharCode(...dsaKeys.publicKey)),
    pqPriv:   btoa(String.fromCharCode(...dsaKeys.secretKey)),
    pqKemPub:  btoa(String.fromCharCode(...kemKeys.publicKey)),
    pqKemPriv: btoa(String.fromCharCode(...kemKeys.secretKey)),
  };
}

/** SHA-256 hex digest */
export async function hashData(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sign `data` and return a self-contained envelope string:
 *   `{"d":"<data>","s":"<base64-ecdsa-sig>"}`
 *
 * Callers treat this as an opaque string; verifySignature unwraps it.
 */
export async function signData(data: string, pair: KeyPair): Promise<string> {
  const key = await importSignPriv(pair.priv);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(data),
  );
  return JSON.stringify({ d: data, s: bufToB64(sig) });
}

/**
 * Verify a signed envelope produced by `signData`.
 * Returns the original data string if the signature is valid, undefined otherwise.
 * Returns the original data string if the signature is valid, undefined otherwise.
 */
export async function verifySignature(signed: string, pub: string): Promise<string | undefined> {
  try {
    const { d, s } = JSON.parse(signed) as { d: string; s: string };
    const key = await importVerifyPub(pub);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64ToBuf(s),
      new TextEncoder().encode(d),
    );
    return valid ? d : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Encrypt a string with the ECDH private key (AES-256-GCM, random IV).
 * Returns `"<base64-iv>:<base64-ciphertext>"`.
 */
export async function encryptData(data: string, pair: KeyPair): Promise<string> {
  const aesKey = await deriveAESFromECDH(pair.epriv);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(data),
  );
  return `${bufToB64(iv.buffer as ArrayBuffer)}:${bufToB64(ct)}`;
}

/** Decrypt a string produced by `encryptData`. Returns undefined on failure. */
export async function decryptData(encrypted: string, pair: KeyPair): Promise<string | undefined> {
  try {
    const [ivB64, ctB64] = encrypted.split(':');
    const aesKey = await deriveAESFromECDH(pair.epriv);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(ivB64) },
      aesKey,
      b64ToBuf(ctB64),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return undefined;
  }
}

/**
 * Encrypt arbitrary bytes with a raw AES-256-GCM key.
 * Used by HeliaStore for content encryption.
 */
export async function encryptBytes(data: Uint8Array, aesKey: CryptoKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, data as unknown as BufferSource);
  const result = new Uint8Array(12 + ct.byteLength);
  result.set(iv);
  result.set(new Uint8Array(ct), 12);
  return result;
}

/** Decrypt bytes produced by `encryptBytes`. Returns undefined on failure. */
export async function decryptBytes(data: Uint8Array, aesKey: CryptoKey): Promise<Uint8Array | undefined> {
  try {
    const iv = data.slice(0, 12);
    const ct = data.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
    return new Uint8Array(plain);
  } catch {
    return undefined;
  }
}

/**
 * Derive a content-encryption AES key from a KeyPair.
 * Used to generate a stable per-account key for encrypting stored content.
 */
export async function deriveContentKey(pair: KeyPair): Promise<CryptoKey> {
  return deriveAESFromECDH(pair.epriv);
}

// ── Quantum-safe signing (ML-DSA-65) ─────────────────────────────────────────

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/**
 * Sign data with ML-DSA-65 (quantum-safe).
 * Returns base64-encoded signature.
 */
export function pqSign(data: string, pqPrivB64: string): string {
  const msg = new TextEncoder().encode(data);
  const secretKey = b64ToBytes(pqPrivB64);
  const sig = ml_dsa65.sign(msg, secretKey);
  return btoa(String.fromCharCode(...sig));
}

/**
 * Verify an ML-DSA-65 signature produced by pqSign.
 */
export function pqVerify(data: string, sigB64: string, pqPubB64: string): boolean {
  try {
    const msg = new TextEncoder().encode(data);
    const sig = b64ToBytes(sigB64);
    const publicKey = b64ToBytes(pqPubB64);
    return ml_dsa65.verify(sig, msg, publicKey);
  } catch {
    return false;
  }
}
