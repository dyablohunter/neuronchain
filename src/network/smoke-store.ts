/**
 * Smoke-based content store - large content storage backed by IndexedDB.
 *
 * Content is content-addressed (stored by SHA-256 CID) which means:
 *   1. Any peer that has the content can serve it to any requester
 *   2. The hash stored on-chain in block.contentCid proves integrity
 *   3. A malicious peer can't serve tampered content - hash mismatch = reject
 *
 * Local storage uses @sinclair/smoke FileSystem (IndexedDB-backed).
 * Peer-to-peer block transfer uses smoke Http (HTTP over WebRTC).
 * WebRTC signaling goes through the relay server's /smoke-hub WebSocket endpoint.
 *
 * Private content is encrypted with the uploader's content key (AES-256-GCM, key
 * derived from the account's ECDH private key). Public content is stored as raw bytes.
 * Only holders of the account's ECDH private key can decrypt private content.
 */

import { Network, FileSystem } from '@sinclair/smoke';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';

import { KeyPair, deriveContentKey, encryptBytes, decryptBytes } from '../core/crypto';

function smokeErrStr(err: unknown): string {
  if (err instanceof AggregateError) {
    const reasons = (err.errors as unknown[]).map(e => e instanceof Error ? e.message : String(e));
    return `[${reasons.join('; ')}]`;
  }
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { const s = JSON.stringify(err); return s === '{}' ? String(err) : s; } catch { return String(err); }
}

export interface ContentMeta {
  mimeType: string;
  size: number;
  encrypted: boolean;
  timestamp: number;
  name?: string;
}

/** Virtual HTTP port used by each SmokeStore node to serve blocks to peers */
const SMOKE_BLOCK_PORT = 5891;

// ── Custom Hub for cross-browser signaling ────────────────────────────────────
// Hubs.Public is unimplemented in @sinclair/smoke 0.8.x (stubs only).
// This hub connects to our relay server's /smoke-hub WebSocket endpoint and
// implements the same interface as Hubs.Private so smoke's WebRTC layer works
// transparently across different browser sessions.

class RelayHub {
  #ws: WebSocket;
  #myAddress: string;
  #handler: ((msg: { to: string; from: string; data: unknown }) => void) | null = null;
  #ready: Promise<void>;

  constructor(wsUrl: string) {
    this.#myAddress = crypto.randomUUID();
    this.#ws = new WebSocket(wsUrl);
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#ws.onopen = () => {
        this.#ws.send(JSON.stringify({ type: 'register', address: this.#myAddress }));
        resolve();
      };
      this.#ws.onerror = () => reject(new Error(`SmokeHub WS error: ${wsUrl}`));
    });
    this.#ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as { to: string; from: string; data: unknown };
        this.#handler?.(msg);
      } catch { /* ignore malformed */ }
    };
  }

  async configuration(): Promise<RTCConfiguration> {
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  }

  async address(): Promise<string> {
    await this.#ready;
    return this.#myAddress;
  }

  send(message: { to: string; data: unknown }): void {
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ from: this.#myAddress, ...message }));
    }
  }

  receive(callback: (message: { to: string; from: string; data: unknown }) => void): void {
    this.#handler = callback;
  }

  dispose(): void {
    this.#ws.close();
  }
}

// ── SmokeStore ────────────────────────────────────────────────────────────────

export class SmokeStore {
  private network!: Network;
  private fs!: FileSystem.FileSystem;
  private hubUrl: string;
  private started = false;
  private peerFallbacks = new Set<string>();

  constructor(hubUrl?: string) {
    this.hubUrl = hubUrl ?? SmokeStore.defaultHubUrl();
  }

  private static defaultHubUrl(): string {
    if (typeof window === 'undefined') return 'ws://localhost:9092/smoke-hub';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/smoke-hub`;
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.network = new Network({ hub: new RelayHub(this.hubUrl) as never });
    this.fs = await FileSystem.open('neuronchain-smoke-blocks');
    await this.fs.mkdir('/blocks');
    await this.fs.mkdir('/cached');

    // Serve locally-stored blocks to any peer that requests them via smoke Http
    this.network.Http.listen({ port: SMOKE_BLOCK_PORT }, async (req: Request) => {
      const pathname = new URL(req.url).pathname;
      const cid = pathname.startsWith('/block/') ? pathname.slice('/block/'.length) : '';
      if (!cid) return new Response('Not Found', { status: 404 });
      try {
        if (!(await this.fs.exists(`/blocks/${cid}`))) return new Response('Not Found', { status: 404 });
        const data = await this.fs.read(`/blocks/${cid}`);
        return new Response(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    });

    this.started = true;
    console.log('[SmokeStore] Started, hub:', this.hubUrl);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.network.dispose();
    this.fs.dispose();
    this.started = false;
  }

  isStarted(): boolean { return this.started; }

  /** Returns our smoke Hub address so it can be included in CacheRequests. */
  async getSmokeHostname(): Promise<string | undefined> {
    try { return await this.network.Hub.address(); } catch { return undefined; }
  }

  /** Register a provider's smoke Hub address so retrieve() can pull from them. */
  addPeerFallback(addr: string): void {
    if (addr) this.peerFallbacks.add(addr);
  }

  getAllPeerFallbacks(): string[] {
    return Array.from(this.peerFallbacks);
  }

  // ── CID generation ─────────────────────────────────────────────────────────

  private async computeCID(data: Uint8Array): Promise<string> {
    const hash = await sha256.digest(data);
    return CID.createV1(raw.code, hash).toString();
  }

  // ── Core store/retrieve ────────────────────────────────────────────────────

  /** Store raw bytes. Returns the CID string (sha256 bafkrei… format). */
  async store(data: Uint8Array): Promise<string> {
    this.assertStarted();
    const cid = await this.computeCID(data);
    await this.fs.write(`/blocks/${cid}`, data);
    return cid;
  }

  /**
   * Retrieve raw bytes by CID string.
   * Checks local storage first. If not found, tries all known peer fallback
   * addresses in parallel via smoke Http (HTTP over WebRTC).
   */
  async retrieve(cidStr: string, timeoutMs = 600_000): Promise<Uint8Array> {
    this.assertStarted();
    const path = `/blocks/${cidStr}`;

    if (await this.fs.exists(path)) {
      return this.fs.read(path);
    }

    const peers = Array.from(this.peerFallbacks);
    if (peers.length === 0) {
      throw new Error(`[SmokeStore] Block not found locally and no peer fallbacks registered: ${cidStr.slice(0, 20)}`);
    }

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[SmokeStore] retrieve timeout after ${timeoutMs}ms`)), timeoutMs),
    );

    const fetchFromPeer = async (peer: string): Promise<Uint8Array> => {
      const url = `http://${peer}:${SMOKE_BLOCK_PORT}/block/${cidStr}`;
      const resp = await this.network.Http.fetch(url);
      if (!resp.ok) throw new Error(`peer ${peer.slice(0, 8)} returned ${resp.status}`);
      const data = new Uint8Array(await resp.arrayBuffer());
      await this.fs.write(path, data);
      return data;
    };

    return Promise.race([
      Promise.any(peers.map(fetchFromPeer)),
      timeout,
    ]);
  }

  // ── Encrypted variants ─────────────────────────────────────────────────────

  async storeEncrypted(data: Uint8Array, keys: KeyPair): Promise<string> {
    const aesKey = await deriveContentKey(keys);
    const encrypted = await encryptBytes(data, aesKey);
    return this.store(encrypted);
  }

  async retrieveDecrypted(cidStr: string, keys: KeyPair, timeoutMs = 600_000): Promise<Uint8Array | undefined> {
    try {
      const encrypted = await this.retrieve(cidStr, timeoutMs);
      const aesKey = await deriveContentKey(keys);
      return decryptBytes(encrypted, aesKey);
    } catch { return undefined; }
  }

  async storeText(text: string, keys: KeyPair): Promise<string> {
    return this.storeEncrypted(new TextEncoder().encode(text), keys);
  }

  async retrieveText(cidStr: string, keys: KeyPair): Promise<string | undefined> {
    const bytes = await this.retrieveDecrypted(cidStr, keys);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  async storeJSON(data: unknown, keys: KeyPair): Promise<string> {
    return this.storeText(JSON.stringify(data), keys);
  }

  async retrieveJSON<T>(cidStr: string, keys: KeyPair): Promise<T | undefined> {
    const text = await this.retrieveText(cidStr, keys);
    if (!text) return undefined;
    try { return JSON.parse(text) as T; } catch { return undefined; }
  }

  // ── Meta envelope variants ─────────────────────────────────────────────────

  async storeWithMeta(
    data: Uint8Array,
    meta: Omit<ContentMeta, 'size' | 'encrypted' | 'timestamp'>,
    keys: KeyPair,
  ): Promise<{ cid: string; meta: ContentMeta }> {
    const contentCid = await this.storeEncrypted(data, keys);
    const fullMeta: ContentMeta & { contentCid: string } = {
      ...meta, size: data.length, encrypted: true, timestamp: Date.now(), contentCid,
    };
    const metaCid = await this.storeJSON(fullMeta, keys);
    return { cid: metaCid, meta: fullMeta };
  }

  async retrieveWithMeta(
    metaCid: string,
    keys: KeyPair,
  ): Promise<{ data: Uint8Array; meta: ContentMeta & { contentCid: string } } | undefined> {
    const meta = await this.retrieveJSON<ContentMeta & { contentCid: string }>(metaCid, keys);
    if (!meta?.contentCid) return undefined;
    const data = await this.retrieveDecrypted(meta.contentCid, keys, 600_000);
    if (!data) return undefined;
    return { data, meta };
  }

  async storeWithMetaPublic(
    data: Uint8Array,
    meta: Omit<ContentMeta, 'size' | 'encrypted' | 'timestamp'>,
  ): Promise<{ cid: string; meta: ContentMeta & { contentCid: string } }> {
    const contentCid = await this.store(data);
    const fullMeta: ContentMeta & { contentCid: string } = {
      ...meta, size: data.length, encrypted: false, timestamp: Date.now(), contentCid,
    };
    const metaCid = await this.store(new TextEncoder().encode(JSON.stringify(fullMeta)));
    return { cid: metaCid, meta: fullMeta };
  }

  async retrieveWithMetaPublic(
    metaCid: string,
  ): Promise<{ data: Uint8Array; meta: ContentMeta & { contentCid: string } } | undefined> {
    try {
      const metaBytes = await this.retrieve(metaCid);
      const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as ContentMeta & { contentCid: string };
      if (!meta?.contentCid) return undefined;
      const data = await this.retrieve(meta.contentCid, 600_000);
      return { data, meta };
    } catch { return undefined; }
  }

  async retrieveAuto(
    metaCid: string,
    keys?: KeyPair,
  ): Promise<{ data: Uint8Array; meta: ContentMeta & { contentCid: string }; wasEncrypted: boolean } | undefined> {
    if (keys) {
      const encrypted = await this.retrieveWithMeta(metaCid, keys);
      if (encrypted) return { ...encrypted, wasEncrypted: true };
    }
    const pub = await this.retrieveWithMetaPublic(metaCid);
    if (pub) return { ...pub, wasEncrypted: false };
    return undefined;
  }

  // ── Provider caching ───────────────────────────────────────────────────────

  /**
   * Cache a block locally so this node can serve it to peers.
   *
   * If the block is already in local storage: just write the /cached marker.
   * If not local and peerHostname is provided: fetch via smoke Http (HTTP over
   * WebRTC), store it, then write the marker. If not local and no peer: throws.
   */
  async cache(cidStr: string, timeoutMs = 600_000, peerHostname?: string): Promise<void> {
    this.assertStarted();
    const blockPath = `/blocks/${cidStr}`;

    if (!(await this.fs.exists(blockPath))) {
      // Collect candidate peers: explicit hint first, then all known fallbacks
      const candidates = peerHostname
        ? [peerHostname, ...Array.from(this.peerFallbacks).filter(p => p !== peerHostname)]
        : Array.from(this.peerFallbacks);

      if (candidates.length === 0) {
        throw new Error(`[SmokeStore] Block not found locally and no peer address available: ${cidStr.slice(0, 16)}`);
      }

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`fetch timeout after ${timeoutMs}ms`)), timeoutMs),
      );

      const fetchFromPeer = async (peer: string): Promise<Uint8Array> => {
        const url = `http://${peer}:${SMOKE_BLOCK_PORT}/block/${cidStr}`;
        let resp: Response;
        try {
          resp = await this.network.Http.fetch(url);
        } catch (e) {
          throw new Error(`peer ${peer.slice(0, 8)}: ${smokeErrStr(e)}`);
        }
        if (!resp.ok) throw new Error(`peer ${peer.slice(0, 8)} returned ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
      };

      const data = await Promise.race([
        Promise.any(candidates.map(fetchFromPeer)),
        timeout,
      ]);
      await this.fs.write(blockPath, data);
    }

    await this.fs.write(`/cached/${cidStr}`, new Uint8Array(0));
  }

  async uncache(cidStr: string): Promise<void> {
    this.assertStarted();
    try { await this.fs.delete(`/cached/${cidStr}`); } catch { /* already removed */ }
  }

  /** Permanently delete a block from local storage (blocks + cached markers). */
  async deleteBlock(cidStr: string): Promise<void> {
    this.assertStarted();
    try { await this.fs.delete(`/blocks/${cidStr}`); } catch { /* already gone */ }
    try { await this.fs.delete(`/cached/${cidStr}`); } catch { /* already gone */ }
  }

  async isCached(cidStr: string): Promise<boolean> {
    this.assertStarted();
    try { return await this.fs.exists(`/cached/${cidStr}`); } catch { return false; }
  }

  async listCached(): Promise<string[]> {
    this.assertStarted();
    try { return await this.fs.readdir('/cached'); } catch { return []; }
  }

  /** Estimate local storage used by block data in bytes */
  async storageUsedBytes(): Promise<number> {
    this.assertStarted();
    try {
      const names = await this.fs.readdir('/blocks');
      let total = 0;
      for (const name of names) {
        try {
          const s = await this.fs.stat(`/blocks/${name}`);
          if (s.type === 'file') total += s.size;
        } catch { /* skip */ }
      }
      return total;
    } catch { return 0; }
  }

  private assertStarted(): void {
    if (!this.started) throw new Error('SmokeStore not started — call start() first');
  }
}
