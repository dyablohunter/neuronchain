/**
 * Helia/IPFS content store - large content storage for social media posts,
 * images, video, audio, JSON documents, HTML/CSS/JS files, etc.
 *
 * Content is content-addressed (stored by SHA-256 CID) which means:
 *   1. Any peer that has the content can serve it to any requester
 *   2. The hash stored on-chain in block.contentCid proves integrity
 *   3. A malicious peer can't serve tampered content - hash mismatch = reject
 *
 * All content is encrypted with the uploader's content key before storing.
 * Only holders of the account's ECDH private key can decrypt their own content.
 * Shared content can optionally use a symmetric key distributed off-band.
 *
 * Usage:
 *   const cid = await heliaStore.storeEncrypted(bytes, mimeType, keys);
 *   const bytes = await heliaStore.retrieveDecrypted(cid, keys);
 */

import { createHelia, Helia } from 'helia';
import { unixfs, UnixFS } from '@helia/unixfs';
import { IDBBlockstore } from 'blockstore-idb';
import { IDBDatastore } from 'datastore-idb';
import { CID } from 'multiformats/cid';

import { KeyPair, deriveContentKey, encryptBytes, decryptBytes } from '../core/crypto';

export interface ContentMeta {
  mimeType: string;
  size: number;
  encrypted: boolean;
  timestamp: number;
  name?: string;
}

export class HeliaStore {
  private helia!: Helia;
  private fs!: UnixFS;
  private blockstore!: IDBBlockstore;
  private datastore!: IDBDatastore;
  private started = false;

  /** Start Helia - shares the same libp2p node for networking */
  async start(libp2pNode?: unknown): Promise<void> {
    if (this.started) return;

    this.blockstore = new IDBBlockstore('neuronchain-helia-blocks');
    this.datastore  = new IDBDatastore('neuronchain-helia-data');
    await this.blockstore.open();
    await this.datastore.open();

    this.helia = await createHelia({
      blockstore: this.blockstore,
      datastore: this.datastore,
      // Share the existing libp2p node so Helia uses the same peer connections
      ...(libp2pNode ? { libp2p: libp2pNode } : {}),
    } as Parameters<typeof createHelia>[0]);

    this.fs = unixfs(this.helia);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.helia.stop();
    await this.blockstore.close();
    await this.datastore.close();
    this.started = false;
  }

  // ── Core store/retrieve ───────────────────────────────────────────────────

  /**
   * Store raw bytes. Returns the CID string.
   * The caller is responsible for any encryption before calling this.
   */
  async store(data: Uint8Array): Promise<string> {
    this.assertStarted();
    const cid = await this.fs.addBytes(data);
    return cid.toString();
  }

  /**
   * Retrieve raw bytes by CID string.
   * Fetches from local store first, then from Helia's BitSwap peer network.
   */
  async retrieve(cidStr: string): Promise<Uint8Array> {
    this.assertStarted();
    const cid = CID.parse(cidStr);
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.fs.cat(cid)) {
      chunks.push(chunk);
    }
    // Concatenate
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { result.set(c, offset); offset += c.length; }
    return result;
  }

  // ── Encrypted variants ────────────────────────────────────────────────────

  /**
   * Encrypt `data` with the account's content key, then store.
   * Returns the CID - store this in block.contentCid.
   */
  async storeEncrypted(data: Uint8Array, keys: KeyPair): Promise<string> {
    const aesKey = await deriveContentKey(keys);
    const encrypted = await encryptBytes(data, aesKey);
    return this.store(encrypted);
  }

  /**
   * Retrieve and decrypt content stored by storeEncrypted.
   * Returns undefined if decryption fails (wrong key or corrupted data).
   */
  async retrieveDecrypted(cidStr: string, keys: KeyPair): Promise<Uint8Array | undefined> {
    const encrypted = await this.retrieve(cidStr);
    const aesKey = await deriveContentKey(keys);
    return decryptBytes(encrypted, aesKey);
  }

  /**
   * Encrypt and store a plain string (JSON, HTML, text, etc.).
   * Returns CID string.
   */
  async storeText(text: string, keys: KeyPair): Promise<string> {
    return this.storeEncrypted(new TextEncoder().encode(text), keys);
  }

  async retrieveText(cidStr: string, keys: KeyPair): Promise<string | undefined> {
    const bytes = await this.retrieveDecrypted(cidStr, keys);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  /**
   * Store a JSON object (encrypted).
   */
  async storeJSON(data: unknown, keys: KeyPair): Promise<string> {
    return this.storeText(JSON.stringify(data), keys);
  }

  async retrieveJSON<T>(cidStr: string, keys: KeyPair): Promise<T | undefined> {
    const text = await this.retrieveText(cidStr, keys);
    if (!text) return undefined;
    try { return JSON.parse(text) as T; } catch { return undefined; }
  }

  /**
   * Store with a metadata envelope (mime type, name, size).
   * The envelope is also encrypted. Returns CID of the envelope.
   */
  async storeWithMeta(data: Uint8Array, meta: Omit<ContentMeta, 'size' | 'encrypted' | 'timestamp'>, keys: KeyPair): Promise<{ cid: string; meta: ContentMeta }> {
    const contentCid = await this.storeEncrypted(data, keys);
    const fullMeta: ContentMeta & { contentCid: string } = {
      ...meta,
      size: data.length,
      encrypted: true,
      timestamp: Date.now(),
      contentCid,
    };
    const metaCid = await this.storeJSON(fullMeta, keys);
    return { cid: metaCid, meta: fullMeta };
  }

  async retrieveWithMeta(metaCid: string, keys: KeyPair): Promise<{ data: Uint8Array; meta: ContentMeta & { contentCid: string } } | undefined> {
    const meta = await this.retrieveJSON<ContentMeta & { contentCid: string }>(metaCid, keys);
    if (!meta?.contentCid) return undefined;
    const data = await this.retrieveDecrypted(meta.contentCid, keys);
    if (!data) return undefined;
    return { data, meta };
  }

  // ── Public (unencrypted) variants ─────────────────────────────────────────

  /**
   * Store with a metadata envelope without encryption - content is publicly readable.
   * Use for posts, profiles, and any content with "public" visibility.
   * The action should still be ECDSA-signed at the block layer.
   */
  async storeWithMetaPublic(data: Uint8Array, meta: Omit<ContentMeta, 'size' | 'encrypted' | 'timestamp'>): Promise<{ cid: string; meta: ContentMeta & { contentCid: string } }> {
    const contentCid = await this.store(data);
    const fullMeta: ContentMeta & { contentCid: string } = {
      ...meta,
      size: data.length,
      encrypted: false,
      timestamp: Date.now(),
      contentCid,
    };
    const metaCid = await this.store(new TextEncoder().encode(JSON.stringify(fullMeta)));
    return { cid: metaCid, meta: fullMeta };
  }

  /**
   * Retrieve public (unencrypted) content stored via storeWithMetaPublic.
   * Anyone can read this - no key required.
   */
  async retrieveWithMetaPublic(metaCid: string): Promise<{ data: Uint8Array; meta: ContentMeta & { contentCid: string } } | undefined> {
    try {
      const metaBytes = await this.retrieve(metaCid);
      const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as ContentMeta & { contentCid: string };
      if (!meta?.contentCid) return undefined;
      const data = await this.retrieve(meta.contentCid);
      return { data, meta };
    } catch { return undefined; }
  }

  /**
   * Auto-detect and retrieve content - tries encrypted first (if keys provided),
   * falls back to public. Works for both visibility modes.
   */
  async retrieveAuto(metaCid: string, keys?: KeyPair): Promise<{ data: Uint8Array; meta: ContentMeta & { contentCid: string }; wasEncrypted: boolean } | undefined> {
    if (keys) {
      const encrypted = await this.retrieveWithMeta(metaCid, keys);
      if (encrypted) return { ...encrypted, wasEncrypted: true };
    }
    const pub = await this.retrieveWithMetaPublic(metaCid);
    if (pub) return { ...pub, wasEncrypted: false };
    return undefined;
  }

  // ── Pinning ───────────────────────────────────────────────────────────────

  /** Pin content locally so it's never garbage-collected */
  async pin(cidStr: string): Promise<void> {
    this.assertStarted();
    const cid = CID.parse(cidStr);
    await this.helia.pins.add(cid);
  }

  /** Unpin content - it will be garbage-collected eventually */
  async unpin(cidStr: string): Promise<void> {
    this.assertStarted();
    try {
      const cid = CID.parse(cidStr);
      await this.helia.pins.rm(cid);
    } catch { /* already unpinned */ }
  }

  /** Check if a CID is pinned locally */
  async isPinned(cidStr: string): Promise<boolean> {
    this.assertStarted();
    try {
      const cid = CID.parse(cidStr);
      for await (const pin of this.helia.pins.ls()) {
        if (pin.cid.equals(cid)) return true;
      }
      return false;
    } catch { return false; }
  }

  /** List all pinned CIDs */
  async listPinned(): Promise<string[]> {
    this.assertStarted();
    const cids: string[] = [];
    for await (const pin of this.helia.pins.ls()) {
      cids.push(pin.cid.toString());
    }
    return cids;
  }

  /** Estimate local storage used in bytes */
  async storageUsedBytes(): Promise<number> {
    this.assertStarted();
    let total = 0;
    for await (const block of this.helia.blockstore.getAll()) {
      total += block.bytes.length;
    }
    return total;
  }

  isStarted(): boolean { return this.started; }

  private assertStarted(): void {
    if (!this.started) throw new Error('HeliaStore not started - call start() first');
  }
}
