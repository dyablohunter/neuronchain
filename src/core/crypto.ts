import Gun from 'gun';
import 'gun/sea.js';

const SEA = Gun.SEA;

export interface KeyPair {
  pub: string;   // ECDSA public key
  priv: string;  // ECDSA private key
  epub: string;  // ECDH public encryption key
  epriv: string; // ECDH private encryption key
}

/** SHA-256 hash using Gun SEA — returns hex string */
export async function hashData(data: string): Promise<string> {
  const hash = await SEA.work(data, null, null, { name: 'SHA-256', encode: 'hex' });
  return hash || '';
}

/** Generate a full ECDSA/ECDH key pair */
export async function generateKeyPair(): Promise<KeyPair> {
  const pair = await SEA.pair();
  return pair as KeyPair;
}

/** Sign data with a key pair — returns signed string */
export async function signData(data: string, pair: KeyPair): Promise<string> {
  const signed = await SEA.sign(data, pair);
  return signed;
}

/** Verify signed data — returns original data or undefined if invalid */
export async function verifySignature(signed: string, pub: string): Promise<string | undefined> {
  const result = await SEA.verify(signed, pub);
  return result as string | undefined;
}

/** Encrypt data with a key pair */
export async function encryptData(data: string, pair: KeyPair): Promise<string> {
  const encrypted = await SEA.encrypt(data, pair);
  return encrypted;
}

/** Decrypt data with a key pair */
export async function decryptData(encrypted: string, pair: KeyPair): Promise<string | undefined> {
  const decrypted = await SEA.decrypt(encrypted, pair);
  return decrypted as string | undefined;
}

export { SEA };
