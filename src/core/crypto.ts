/**
 * Cryptographic primitives — pure Web Crypto API, no external dependencies.
 *
 * Key pairs use ECDSA P-256 for signing and ECDH P-256 for encryption.
 * Keys are serialised as base64-encoded JWK JSON strings so they can be
 * stored in localStorage / IndexedDB / libp2p without binary concerns.
 *
 * Signature wire format: JSON string `{"d":"<original-data>","s":"<base64-sig>"}`
 * verifySignature returns the original data string on success, undefined on failure.
 */

export interface KeyPair {
  pub: string;   // ECDSA P-256 public key  — base64(JSON(JWK))
  priv: string;  // ECDSA P-256 private key — base64(JSON(JWK))
  epub: string;  // ECDH  P-256 public key  — base64(JSON(JWK))
  epriv: string; // ECDH  P-256 private key — base64(JSON(JWK))
}

// ── Byte helpers ──────────────────────────────────────────────────────────────

function bufToB64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64ToBuf(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
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
  // Strip private scalar (d) if present — public-key-only import
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

/** Generate a fresh ECDSA/ECDH P-256 key pair */
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
  return { pub, priv, epub, epriv };
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
  return `${bufToB64(iv.buffer)}:${bufToB64(ct)}`;
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
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, data);
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
