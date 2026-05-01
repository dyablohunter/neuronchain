/**
 * Smoke-based content store.
 *
 * Small files (≤ 8 MB): stored as single blocks in the smoke virtual FS (IndexedDB-backed).
 * Large files  (> 8 MB): split into 8 MB chunks, each encrypted independently with
 *   AES-256-GCM (IV embedded in cipher-text), stored in OPFS (Origin Private File System).
 *   A small JSON manifest listing the chunk CIDs is stored in the smoke FS.
 *
 * Peer-to-peer block transfer uses smoke Http (HTTP-over-WebRTC). The smoke HTTP server
 * serves both smoke-FS blocks and OPFS chunks transparently.
 *
 * Private content is encrypted with the uploader's content key (AES-256-GCM, key derived
 * from the account's ECDH private key). Public content is stored as raw bytes.
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

/**
 * One chunk of a large (> 8 MB) file stored in OPFS.
 * The CID is the SHA-256 of the stored bytes (encrypted or raw).
 * The IV for AES-GCM is embedded in the first 12 bytes of the stored ciphertext
 * (same layout as encryptBytes / decryptBytes in crypto.ts).
 */
export interface StreamChunk {
  cid: string;
  size: number; // stored byte length (after encryption)
}

/** Virtual HTTP port used by each SmokeStore node to serve blocks to peers */
const SMOKE_BLOCK_PORT = 5891;

/** Files above this threshold use the OPFS streaming path (8 MB) */
export const STREAM_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Fetched blocks above this size are stored in OPFS rather than the smoke FS.
 * Set to half a chunk so the last (possibly smaller) chunk still lands in OPFS.
 */
const OPFS_WRITE_THRESHOLD = 4 * 1024 * 1024;

// ── GossipSub adapter interface ───────────────────────────────────────────────

export interface GossipSubAdapter {
  peerId: string;
  networkId: string;
  publish(topic: string, data: Uint8Array): void | Promise<void>;
  subscribe(topic: string): void;
  addEventListener(event: 'message', handler: EventListener): void;
  removeEventListener(event: 'message', handler: EventListener): void;
}

// ── GossipSubHub ──────────────────────────────────────────────────────────────

function webrtcSignalTopic(networkId: string, targetPeerId: string): string {
  return `neuronchain/${networkId}/ws/${targetPeerId}`;
}

const enc2 = new TextEncoder();
const dec2 = new TextDecoder();

class GossipSubHub {
  #adapter: GossipSubAdapter;
  #myTopic: string;
  #msgListener: EventListener | null = null;

  constructor(adapter: GossipSubAdapter) {
    this.#adapter = adapter;
    this.#myTopic = webrtcSignalTopic(adapter.networkId, adapter.peerId);
    try { adapter.subscribe(this.#myTopic); } catch { /* ignore */ }
  }

  async configuration(): Promise<RTCConfiguration> {
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  }

  async address(): Promise<string> { return this.#adapter.peerId; }

  send(message: { to: string; data: unknown }): void {
    const topic = webrtcSignalTopic(this.#adapter.networkId, message.to);
    const payload = enc2.encode(JSON.stringify({ from: this.#adapter.peerId, to: message.to, data: message.data }));
    try {
      const r = this.#adapter.publish(topic, payload);
      if (r instanceof Promise) r.catch(() => {});
    } catch { /* ignore */ }
  }

  receive(callback: (message: { to: string; from: string; data: unknown }) => void): void {
    const myTopic = this.#myTopic;
    const myPeerId = this.#adapter.peerId;
    this.#msgListener = ((evt: Event) => {
      const detail = (evt as CustomEvent<{ topic: string; data: Uint8Array }>).detail;
      if (detail.topic !== myTopic) return;
      try {
        const parsed = JSON.parse(dec2.decode(detail.data)) as { from: string; to: string; data: unknown };
        if (parsed.to === myPeerId) callback(parsed);
      } catch { /* ignore malformed */ }
    }) as EventListener;
    this.#adapter.addEventListener('message', this.#msgListener);
  }

  dispose(): void {
    if (this.#msgListener) {
      this.#adapter.removeEventListener('message', this.#msgListener);
      this.#msgListener = null;
    }
  }
}

// ── RelayHub (WebSocket fallback) ─────────────────────────────────────────────

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

  /** OPFS directory handle for large blocks — null if OPFS unavailable */
  private opfsBlocks: FileSystemDirectoryHandle | null = null;

  /** Called when a block is successfully received via push (POST). StorageManager uses this to issue a receipt. */
  private blockPushHandler?: (cid: string, uploaderPub: string | undefined) => void;

  constructor(hubUrl?: string) {
    this.hubUrl = hubUrl ?? SmokeStore.defaultHubUrl();
  }

  private static defaultHubUrl(): string {
    if (typeof window === 'undefined') return 'ws://localhost:9092/smoke-hub';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/smoke-hub`;
  }

  async start(gsAdapter?: GossipSubAdapter): Promise<void> {
    if (this.started) return;

    const hub = gsAdapter ? new GossipSubHub(gsAdapter) : new RelayHub(this.hubUrl);
    this.network = new Network({ hub: hub as never });
    this.fs = await FileSystem.open('neuronchain-smoke-blocks');
    await this.fs.mkdir('/blocks');
    await this.fs.mkdir('/cached');
    await this.fs.mkdir('/cached-meta');
    await this.fs.mkdir('/chunk-index');
    await this.fs.mkdir('/cache-groups');

    // Initialise OPFS directory for large blocks
    try {
      const root = await navigator.storage.getDirectory();
      this.opfsBlocks = await root.getDirectoryHandle('neuronchain-large-blocks', { create: true });
      console.log('[SmokeStore] OPFS available — large files will use streaming path');
    } catch {
      console.warn('[SmokeStore] OPFS unavailable — large files will fall back to IDB (may fail for very large content)');
    }

    // Serve blocks to peers. Checks smoke FS first (small blocks + manifests),
    // then OPFS (large chunks). Both support Range requests for spot-checks.
    this.network.Http.listen({ port: SMOKE_BLOCK_PORT }, async (req: Request) => {
      const pathname = new URL(req.url).pathname;
      const cid = pathname.startsWith('/block/') ? pathname.slice('/block/'.length) : '';
      if (!cid) return new Response('Not Found', { status: 404 });

      // ── POST: receive a block pushed by the uploader ──────────────────────
      if (req.method === 'POST') {
        try {
          const uploaderPub = new URL(req.url).searchParams.get('uploaderPub') ?? undefined;
          const data = new Uint8Array(await req.arrayBuffer());
          const computedCid = await this.computeCID(data);
          if (computedCid !== cid) {
            console.warn(`[SmokeStore] push-receive: CID mismatch for ${cid.slice(0, 20)}… (got ${computedCid.slice(0, 20)}…)`);
            return new Response('CID mismatch', { status: 400 });
          }
          if (data.byteLength >= OPFS_WRITE_THRESHOLD) {
            await this.writeToOPFS(cid, data);
          } else {
            await this.fs.write(`/blocks/${cid}`, data);
          }
          console.log(`[SmokeStore] push-receive: stored ${(data.byteLength / 1_048_576).toFixed(2)} MB for ${cid.slice(0, 20)}…`);
          // Notify StorageManager so it can write the cached marker and publish a receipt
          this.blockPushHandler?.(cid, uploaderPub);
          return new Response('OK', { status: 200 });
        } catch (e) {
          console.warn(`[SmokeStore] push-receive error for ${cid.slice(0, 20)}…:`, e instanceof Error ? e.message : String(e));
          return new Response('Internal Error', { status: 500 });
        }
      }

      try {
        // ── smoke FS (small blocks / manifests) ──────────────────────────────
        if (await this.fs.exists(`/blocks/${cid}`)) {
          const data = await this.fs.read(`/blocks/${cid}`);
          const rangeHeader = req.headers.get('range');
          if (rangeHeader) {
            const m = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
            if (m) {
              const start = parseInt(m[1], 10);
              const end   = Math.min(parseInt(m[2], 10), data.byteLength - 1);
              if (start < 0 || start >= data.byteLength || start > end) {
                return new Response('Range Not Satisfiable', { status: 416,
                  headers: { 'Content-Range': `bytes */${data.byteLength}` } });
              }
              const slice = data.slice(start, end + 1);
              return new Response(
                slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer,
                { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${data.byteLength}` } },
              );
            }
          }
          return new Response(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
        }

        // ── OPFS (large chunks) ───────────────────────────────────────────────
        const opfsFile = await this.readFromOPFS(cid);
        if (opfsFile) {
          const rangeHeader = req.headers.get('range');
          if (rangeHeader) {
            const m = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
            if (m) {
              const start = parseInt(m[1], 10);
              const end   = Math.min(parseInt(m[2], 10), opfsFile.size - 1);
              if (start < 0 || start >= opfsFile.size || start > end) {
                return new Response('Range Not Satisfiable', { status: 416,
                  headers: { 'Content-Range': `bytes */${opfsFile.size}` } });
              }
              return new Response(opfsFile.slice(start, end + 1).stream(),
                { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${opfsFile.size}` } });
            }
          }
          // Stream directly from OPFS — no RAM copy needed
          return new Response(opfsFile.stream(),
            { headers: { 'Content-Length': String(opfsFile.size) } });
        }

        // Log on the server side so the uploader can confirm whether the block is genuinely absent
        const blockCount = (await this.fs.readdir('/blocks').catch(() => [])).length;
        console.warn(`[SmokeStore] serve 404: ${cid.slice(0, 20)}… not in smoke FS or OPFS (smoke FS has ${blockCount} block(s))`);
        return new Response('Not Found', { status: 404 });
      } catch (e) {
        console.warn(`[SmokeStore] serve error for ${cid.slice(0, 20)}…:`, e instanceof Error ? e.message : String(e));
        return new Response('Not Found', { status: 404 });
      }
    });

    this.started = true;
    console.log('[SmokeStore] Started, hub:', gsAdapter ? 'GossipSub' : this.hubUrl);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.network.dispose();
    this.fs.dispose();
    this.started = false;
  }

  isStarted(): boolean { return this.started; }

  async getSmokeHostname(): Promise<string | undefined> {
    try { return await this.network.Hub.address(); } catch { return undefined; }
  }

  addPeerFallback(addr: string): void {
    if (addr) this.peerFallbacks.add(addr);
  }

  getAllPeerFallbacks(): string[] {
    return Array.from(this.peerFallbacks);
  }

  // ── OPFS helpers ───────────────────────────────────────────────────────────

  private async writeToOPFS(cid: string, data: Uint8Array): Promise<void> {
    if (!this.opfsBlocks) return;
    try {
      const fh = await this.opfsBlocks.getFileHandle(cid, { create: true });
      const writable = await fh.createWritable();
      await writable.write(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      await writable.close();
    } catch (err) {
      console.error(`[SmokeStore] OPFS write failed for ${cid.slice(0, 16)}…`, err);
      throw err;
    }
  }

  private async readFromOPFS(cid: string): Promise<File | null> {
    if (!this.opfsBlocks) return null;
    try {
      const fh = await this.opfsBlocks.getFileHandle(cid);
      return await fh.getFile();
    } catch { return null; }
  }

  private async existsInOPFS(cid: string): Promise<boolean> {
    if (!this.opfsBlocks) return false;
    try { await this.opfsBlocks.getFileHandle(cid); return true; } catch { return false; }
  }

  private async deleteFromOPFS(cid: string): Promise<void> {
    if (!this.opfsBlocks) return;
    try { await this.opfsBlocks.removeEntry(cid); } catch { /* already gone */ }
  }

  /** Persist the list of chunk CIDs for a manifest so deleteBlock can clean up OPFS. */
  private async saveChunkIndex(metaCid: string, chunkCids: string[]): Promise<void> {
    await this.fs.write(`/chunk-index/${metaCid}`,
      new TextEncoder().encode(JSON.stringify(chunkCids)));
  }

  private async loadChunkIndex(metaCid: string): Promise<string[] | null> {
    try {
      if (!(await this.fs.exists(`/chunk-index/${metaCid}`))) return null;
      const bytes = await this.fs.read(`/chunk-index/${metaCid}`);
      return JSON.parse(new TextDecoder().decode(bytes)) as string[];
    } catch { return null; }
  }

  /** Save the sub-CIDs that belong to a cached root CID (written by caching nodes at cache time). */
  async saveCacheGroup(rootCid: string, subCids: string[]): Promise<void> {
    if (subCids.length === 0) return;
    await this.fs.write(`/cache-groups/${rootCid}`,
      new TextEncoder().encode(JSON.stringify(subCids)));
  }

  private async loadCacheGroup(rootCid: string): Promise<string[] | null> {
    try {
      if (!(await this.fs.exists(`/cache-groups/${rootCid}`))) return null;
      const bytes = await this.fs.read(`/cache-groups/${rootCid}`);
      return JSON.parse(new TextDecoder().decode(bytes)) as string[];
    } catch { return null; }
  }

  // ── CID generation ─────────────────────────────────────────────────────────

  private async computeCID(data: Uint8Array): Promise<string> {
    const hash = await sha256.digest(data);
    return CID.createV1(raw.code, hash).toString();
  }

  // ── Core store / retrieve ──────────────────────────────────────────────────

  /** Store raw bytes in the smoke FS. Returns the CID. */
  async store(data: Uint8Array): Promise<string> {
    this.assertStarted();
    const mb = (data.byteLength / 1_048_576).toFixed(2);
    console.log(`[SmokeStore] store: computing CID for ${mb} MB`);
    const t0 = performance.now();
    const cid = await this.computeCID(data);
    console.log(`[SmokeStore] store: CID=${cid.slice(0, 20)}… writing to IDB (${mb} MB)`);
    try {
      await this.fs.write(`/blocks/${cid}`, data);
      console.log(`[SmokeStore] store: IDB write done in ${(performance.now() - t0).toFixed(0)} ms`);
    } catch (err) {
      console.error(`[SmokeStore] store: IDB write FAILED for ${mb} MB block`, err);
      throw err;
    }
    return cid;
  }

  /**
   * Retrieve raw bytes by CID.
   * Order: smoke FS → OPFS → peer fetch (first responder wins).
   * Fetched blocks ≥ 4 MB go to OPFS; smaller blocks go to smoke FS.
   */
  async retrieve(cidStr: string, timeoutMs = 600_000, priorityPeers?: string[]): Promise<Uint8Array> {
    this.assertStarted();
    const path = `/blocks/${cidStr}`;
    const shortCid = cidStr.slice(0, 20);

    // Local smoke FS
    if (await this.fs.exists(path)) {
      console.log(`[SmokeStore] retrieve: smoke FS hit for ${shortCid}…`);
      const t0 = performance.now();
      const data = await this.fs.read(path);
      console.log(`[SmokeStore] retrieve: read ${(data.byteLength / 1_048_576).toFixed(2)} MB in ${(performance.now() - t0).toFixed(0)} ms`);
      return data;
    }

    // OPFS (large chunks)
    const opfsFile = await this.readFromOPFS(cidStr);
    if (opfsFile) {
      console.log(`[SmokeStore] retrieve: OPFS hit for ${shortCid}… (${(opfsFile.size / 1_048_576).toFixed(2)} MB)`);
      return new Uint8Array(await opfsFile.arrayBuffer());
    }

    // Peer fetch
    const prioritySet = new Set(priorityPeers ?? []);
    const peers = [
      ...Array.from(prioritySet),
      ...Array.from(this.peerFallbacks).filter(p => !prioritySet.has(p)),
    ];
    console.log(`[SmokeStore] retrieve: ${shortCid}… not local — trying ${peers.length} peer(s)`);
    if (peers.length === 0) throw new Error(`Block not found locally and no peer fallbacks: ${shortCid}`);

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`retrieve timeout after ${timeoutMs}ms`)), timeoutMs));

    const fetchFromPeer = async (peer: string): Promise<Uint8Array> => {
      const url = `http://${peer}:${SMOKE_BLOCK_PORT}/block/${cidStr}`;
      console.log(`[SmokeStore] retrieve: fetching ${shortCid}… from ${peer.slice(0, 12)}`);
      const t0 = performance.now();
      const resp = await this.network.Http.fetch(url);
      if (!resp.ok) throw new Error(`peer ${peer.slice(0, 8)} returned ${resp.status}`);
      const data = new Uint8Array(await resp.arrayBuffer());
      const mb = (data.byteLength / 1_048_576).toFixed(2);
      console.log(`[SmokeStore] retrieve: received ${mb} MB from ${peer.slice(0, 12)} in ${(performance.now() - t0).toFixed(0)} ms`);
      // Route to OPFS if large, smoke FS if small
      if (data.byteLength >= OPFS_WRITE_THRESHOLD) {
        await this.writeToOPFS(cidStr, data);
      } else {
        try {
          await this.fs.write(path, data);
        } catch (err) {
          console.error(`[SmokeStore] retrieve: IDB write FAILED for ${mb} MB`, err);
          throw err;
        }
      }
      return data;
    };

    return Promise.race([Promise.any(peers.map(fetchFromPeer)), timeout]);
  }

  async verifyBlockIntegrity(cidStr: string, data: Uint8Array): Promise<boolean> {
    try {
      const expected = await this.computeCID(data);
      return expected === cidStr;
    } catch { return false; }
  }

  // ── Encrypted variants ─────────────────────────────────────────────────────

  async storeEncrypted(data: Uint8Array, keys: KeyPair): Promise<string> {
    const mb = (data.byteLength / 1_048_576).toFixed(2);
    console.log(`[SmokeStore] storeEncrypted: encrypting ${mb} MB`);
    const t0 = performance.now();
    const aesKey = await deriveContentKey(keys);
    const encrypted = await encryptBytes(data, aesKey);
    console.log(`[SmokeStore] storeEncrypted: AES-256-GCM done in ${(performance.now() - t0).toFixed(0)} ms`);
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

  // ── Large-file chunked OPFS helpers ───────────────────────────────────────

  /**
   * Split data into STREAM_CHUNK_SIZE chunks, optionally encrypt each, store to OPFS.
   * Returns the StreamChunk list for inclusion in the manifest.
   */
  private async storeChunks(
    data: Uint8Array,
    aesKey?: CryptoKey,
  ): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = [];
    let offset = 0;
    let idx = 0;
    while (offset < data.byteLength) {
      const slice = data.subarray(offset, offset + STREAM_CHUNK_SIZE);
      const stored = aesKey ? await encryptBytes(slice, aesKey) : slice;
      const cid = await this.computeCID(stored);
      await this.writeToOPFS(cid, stored);
      chunks.push({ cid, size: stored.byteLength });
      console.log(`[SmokeStore] storeChunks: chunk ${idx} CID=${cid.slice(0, 16)}… (${(stored.byteLength / 1_048_576).toFixed(2)} MB)`);
      offset += STREAM_CHUNK_SIZE;
      idx++;
    }
    return chunks;
  }

  // ── Meta envelope variants ─────────────────────────────────────────────────

  async storeWithMeta(
    data: Uint8Array,
    meta: Omit<ContentMeta, 'size' | 'encrypted' | 'timestamp'>,
    keys: KeyPair,
  ): Promise<{ cid: string; meta: ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] } }> {
    const mb = (data.byteLength / 1_048_576).toFixed(2);
    console.log(`[SmokeStore] storeWithMeta: "${meta.name ?? 'unnamed'}" ${mb} MB (${meta.mimeType}) — private`);
    const t0 = performance.now();

    if (data.byteLength > STREAM_CHUNK_SIZE) {
      // ── Large file: chunked OPFS path ──────────────────────────────────────
      console.log(`[SmokeStore] storeWithMeta: large file — using OPFS chunked path`);
      const aesKey = await deriveContentKey(keys);
      const chunks = await this.storeChunks(data, aesKey);
      const fullMeta: ContentMeta & { streamChunks: StreamChunk[] } = {
        ...meta, size: data.byteLength, encrypted: true, timestamp: Date.now(), streamChunks: chunks,
      };
      // Encrypt the manifest so only the key-holder can see chunk CIDs
      const metaCid = await this.storeJSON(fullMeta, keys);
      // Store an unencrypted chunk index for deleteBlock (CIDs aren't sensitive)
      await this.saveChunkIndex(metaCid, chunks.map(c => c.cid));
      console.log(`[SmokeStore] storeWithMeta: done in ${(performance.now() - t0).toFixed(0)} ms — ${chunks.length} chunks, metaCid=${metaCid.slice(0, 20)}…`);
      return { cid: metaCid, meta: fullMeta };
    }

    // ── Small file: existing IDB path ──────────────────────────────────────
    const contentCid = await this.storeEncrypted(data, keys);
    const fullMeta: ContentMeta & { contentCid: string } = {
      ...meta, size: data.byteLength, encrypted: true, timestamp: Date.now(), contentCid,
    };
    const metaCid = await this.storeJSON(fullMeta, keys);
    console.log(`[SmokeStore] storeWithMeta: done in ${(performance.now() - t0).toFixed(0)} ms — metaCid=${metaCid.slice(0, 20)}… contentCid=${contentCid.slice(0, 20)}…`);
    return { cid: metaCid, meta: fullMeta };
  }

  async retrieveWithMeta(
    metaCid: string,
    keys: KeyPair,
  ): Promise<{ data: Uint8Array; meta: ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] } } | undefined> {
    const meta = await this.retrieveJSON<ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] }>(metaCid, keys);
    if (!meta) return undefined;

    if (meta.streamChunks?.length) {
      // Assemble from OPFS chunks (use retrieveStream for true streaming)
      const aesKey = await deriveContentKey(keys);
      const parts: Uint8Array[] = [];
      for (const chunk of meta.streamChunks) {
        const opfsFile = await this.readFromOPFS(chunk.cid);
        const raw = opfsFile
          ? new Uint8Array(await opfsFile.arrayBuffer())
          : await this.retrieve(chunk.cid);
        const plain = await decryptBytes(raw, aesKey);
        if (!plain) return undefined;
        parts.push(plain);
      }
      const data = concatBytes(parts);
      return { data, meta };
    }

    if (!meta.contentCid) return undefined;
    const data = await this.retrieveDecrypted(meta.contentCid, keys, 600_000);
    if (!data) return undefined;
    return { data, meta };
  }

  async storeWithMetaPublic(
    data: Uint8Array,
    meta: Omit<ContentMeta, 'size' | 'encrypted' | 'timestamp'>,
  ): Promise<{ cid: string; meta: ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] } }> {
    const mb = (data.byteLength / 1_048_576).toFixed(2);
    console.log(`[SmokeStore] storeWithMetaPublic: "${meta.name ?? 'unnamed'}" ${mb} MB (${meta.mimeType}) — public`);
    const t0 = performance.now();

    if (data.byteLength > STREAM_CHUNK_SIZE) {
      // ── Large file: chunked OPFS path (unencrypted) ─────────────────────
      console.log(`[SmokeStore] storeWithMetaPublic: large file — using OPFS chunked path`);
      const chunks = await this.storeChunks(data);
      const fullMeta: ContentMeta & { streamChunks: StreamChunk[] } = {
        ...meta, size: data.byteLength, encrypted: false, timestamp: Date.now(), streamChunks: chunks,
      };
      const metaCid = await this.store(new TextEncoder().encode(JSON.stringify(fullMeta)));
      await this.saveChunkIndex(metaCid, chunks.map(c => c.cid));
      console.log(`[SmokeStore] storeWithMetaPublic: done in ${(performance.now() - t0).toFixed(0)} ms — ${chunks.length} chunks, metaCid=${metaCid.slice(0, 20)}…`);
      return { cid: metaCid, meta: fullMeta };
    }

    // ── Small file: existing IDB path ──────────────────────────────────────
    const contentCid = await this.store(data);
    const fullMeta: ContentMeta & { contentCid: string } = {
      ...meta, size: data.byteLength, encrypted: false, timestamp: Date.now(), contentCid,
    };
    const metaCid = await this.store(new TextEncoder().encode(JSON.stringify(fullMeta)));
    console.log(`[SmokeStore] storeWithMetaPublic: done in ${(performance.now() - t0).toFixed(0)} ms — metaCid=${metaCid.slice(0, 20)}… contentCid=${contentCid.slice(0, 20)}…`);
    return { cid: metaCid, meta: fullMeta };
  }

  async retrieveWithMetaPublic(
    metaCid: string,
  ): Promise<{ data: Uint8Array; meta: ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] } } | undefined> {
    try {
      const metaBytes = await this.retrieve(metaCid);
      const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] };
      if (!meta) return undefined;

      if (meta.streamChunks?.length) {
        const parts: Uint8Array[] = [];
        for (const chunk of meta.streamChunks) {
          const opfsFile = await this.readFromOPFS(chunk.cid);
          const raw = opfsFile
            ? new Uint8Array(await opfsFile.arrayBuffer())
            : await this.retrieve(chunk.cid);
          parts.push(raw);
        }
        return { data: concatBytes(parts), meta };
      }

      if (!meta.contentCid) return undefined;
      const data = await this.retrieve(meta.contentCid, 600_000);
      return { data, meta };
    } catch { return undefined; }
  }

  async retrieveAuto(
    metaCid: string,
    keys?: KeyPair,
  ): Promise<{ data: Uint8Array; meta: ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] }; wasEncrypted: boolean } | undefined> {
    if (keys) {
      const encrypted = await this.retrieveWithMeta(metaCid, keys);
      if (encrypted) return { ...encrypted, wasEncrypted: true };
    }
    const pub = await this.retrieveWithMetaPublic(metaCid);
    if (pub) return { ...pub, wasEncrypted: false };
    return undefined;
  }

  // ── Stream API — large file check + streaming retrieval ───────────────────

  /**
   * Check whether content is locally available without fully loading it.
   * For large files, only the first chunk is probed.
   * For small files, only the content block presence is checked.
   *
   * Returns:
   *   available  — true if the content can be retrieved right now
   *   isStream   — true if the file uses the OPFS streaming path (> 8 MB)
   *   meta       — ContentMeta if the manifest was readable; undefined if not found
   */
  async checkAvailability(
    metaCid: string,
    keys?: KeyPair,
  ): Promise<{
    available: boolean;
    isStream: boolean;
    meta?: ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] };
  }> {
    this.assertStarted();
    type FullMeta = ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] };
    let meta: FullMeta | undefined;

    // Try encrypted manifest first (if keys provided)
    if (keys) {
      meta = await this.retrieveJSON<FullMeta>(metaCid, keys);
    }
    // Fall back to unencrypted JSON
    if (!meta) {
      try {
        const bytes = await this.retrieve(metaCid);
        meta = JSON.parse(new TextDecoder().decode(bytes)) as FullMeta;
      } catch { /* not found */ }
    }

    if (!meta) return { available: false, isStream: false };

    const isStream = Array.isArray(meta.streamChunks) && meta.streamChunks.length > 0;

    if (isStream) {
      const firstCid = meta.streamChunks![0].cid;
      const available = await this.existsInOPFS(firstCid) ||
        await this.fs.exists(`/blocks/${firstCid}`);
      return { available, isStream: true, meta };
    }

    const contentCid = meta.contentCid;
    if (!contentCid) return { available: false, isStream: false, meta };
    const available = await this.fs.exists(`/blocks/${contentCid}`) ||
      await this.existsInOPFS(contentCid);
    return { available, isStream: false, meta };
  }

  /**
   * Return a pull-based ReadableStream that yields decrypted (or raw) chunks one at a time.
   * Each chunk is read from OPFS or fetched from a peer on demand — the file is never
   * fully loaded into RAM simultaneously.
   *
   * Also returns the ContentMeta so the caller knows mimeType, size, name, etc.
   * Returns undefined if the manifest cannot be read.
   */
  async retrieveStream(
    metaCid: string,
    keys?: KeyPair,
  ): Promise<{
    stream: ReadableStream<Uint8Array>;
    meta: ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] };
  } | undefined> {
    this.assertStarted();
    type FullMeta = ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] };
    let meta: FullMeta | undefined;

    if (keys) {
      meta = await this.retrieveJSON<FullMeta>(metaCid, keys);
    }
    if (!meta) {
      try {
        const bytes = await this.retrieve(metaCid);
        meta = JSON.parse(new TextDecoder().decode(bytes)) as FullMeta;
      } catch { return undefined; }
    }
    if (!meta) return undefined;

    if (!meta.streamChunks?.length) {
      // Small file — wrap in a single-chunk stream for uniform API
      const smallMeta = meta;
      const store = this;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            let data: Uint8Array | undefined;
            if (smallMeta.encrypted && keys) {
              data = await store.retrieveDecrypted(smallMeta.contentCid!, keys);
            } else if (smallMeta.contentCid) {
              data = await store.retrieve(smallMeta.contentCid);
            }
            if (data) controller.enqueue(data);
            controller.close();
          } catch (e) { controller.error(e); }
        },
      });
      return { stream, meta };
    }

    // Large file — pull-based stream, one OPFS chunk at a time
    const chunks = meta.streamChunks;
    const aesKey = keys && meta.encrypted ? await deriveContentKey(keys) : undefined;
    let chunkIdx = 0;
    const store = this;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunkIdx >= chunks.length) { controller.close(); return; }
        const chunk = chunks[chunkIdx++];
        try {
          let raw: Uint8Array;
          const opfsFile = await store.readFromOPFS(chunk.cid);
          if (opfsFile) {
            raw = new Uint8Array(await opfsFile.arrayBuffer());
          } else {
            raw = await store.retrieve(chunk.cid);
            // Cache fetched chunk in OPFS for next access
            await store.writeToOPFS(chunk.cid, raw);
          }
          if (aesKey) {
            const plain = await decryptBytes(raw, aesKey);
            if (!plain) { controller.error(new Error(`Chunk ${chunkIdx} decryption failed`)); return; }
            controller.enqueue(plain);
          } else {
            controller.enqueue(raw);
          }
        } catch (e) { controller.error(e); }
      },
    });

    return { stream, meta };
  }

  /**
   * Return exactly the bytes [start, end] (inclusive, 0-indexed plaintext offsets) for a large
   * file. Used by the streaming Service Worker to serve HTTP Range requests without loading the
   * full file into RAM — only the overlapping 8 MB OPFS chunk(s) are read and decrypted.
   */
  async getChunkBytes(
    metaCid: string,
    start: number,
    end: number,
    keys?: KeyPair,
  ): Promise<Uint8Array | undefined> {
    this.assertStarted();
    type FullMeta = ContentMeta & { contentCid?: string; streamChunks?: StreamChunk[] };
    let meta: FullMeta | undefined;

    if (keys) meta = await this.retrieveJSON<FullMeta>(metaCid, keys);
    if (!meta) {
      try {
        const bytes = await this.retrieve(metaCid);
        meta = JSON.parse(new TextDecoder().decode(bytes)) as FullMeta;
      } catch { return undefined; }
    }
    if (!meta?.streamChunks?.length) return undefined;

    const chunks = meta.streamChunks;
    const aesKey = keys && meta.encrypted ? await deriveContentKey(keys) : undefined;
    const parts: Uint8Array[] = [];
    let plainOffset = 0;

    for (const chunk of chunks) {
      // All chunks are STREAM_CHUNK_SIZE except the last, which fills the remainder.
      const plainChunkSize = Math.min(STREAM_CHUNK_SIZE, meta.size - plainOffset);
      const chunkEnd = plainOffset + plainChunkSize - 1; // inclusive

      if (chunkEnd >= start && plainOffset <= end) {
        const opfsFile = await this.readFromOPFS(chunk.cid);
        const raw = opfsFile
          ? new Uint8Array(await opfsFile.arrayBuffer())
          : await this.retrieve(chunk.cid);
        const plain = aesKey ? await decryptBytes(raw, aesKey) : raw;
        if (!plain) throw new Error(`Decryption failed for chunk ${chunk.cid}`);

        const sliceStart = Math.max(0, start - plainOffset);
        const sliceEnd = Math.min(plain.byteLength, end - plainOffset + 1);
        parts.push(plain.subarray(sliceStart, sliceEnd));
      }

      plainOffset += plainChunkSize;
      if (plainOffset > end) break;
    }

    return parts.length === 1 ? parts[0] : concatBytes(parts);
  }

  // ── Provider caching ───────────────────────────────────────────────────────

  async cache(cidStr: string, timeoutMs = 600_000, peerHostname?: string, uploaderPub?: string, extraFallbacks?: string[]): Promise<void> {
    this.assertStarted();
    const blockPath = `/blocks/${cidStr}`;

    const alreadyInSmokeFs = await this.fs.exists(blockPath);
    const alreadyInOPFS = !alreadyInSmokeFs && await this.existsInOPFS(cidStr);

    if (!alreadyInSmokeFs && !alreadyInOPFS) {
      // Use only the explicit uploader address and confirmed-provider fallbacks.
      // Avoid the blind peerFallbacks set (contains all ever-seen smoke addresses) because
      // most will 404 or time out for any given CID, wasting several seconds per attempt.
      const extra = (extraFallbacks ?? []).filter(p => p !== peerHostname);
      const candidates = peerHostname
        ? [peerHostname, ...extra]
        : extra;

      if (candidates.length === 0) {
        throw new Error(`Block not found locally and no peer address available: ${cidStr.slice(0, 16)}`);
      }

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`fetch timeout after ${timeoutMs}ms`)), timeoutMs));

      const fetchFromPeer = async (peer: string): Promise<Uint8Array> => {
        const url = `http://${peer}:${SMOKE_BLOCK_PORT}/block/${cidStr}`;
        console.log(`[SmokeStore] cache: fetching ${cidStr.slice(0, 20)}… from ${peer.slice(0, 12)}`);
        const t0 = performance.now();
        let resp: Response;
        try {
          resp = await this.network.Http.fetch(url);
        } catch (e) {
          console.warn(`[SmokeStore] cache: fetch failed from ${peer.slice(0, 12)} —`, smokeErrStr(e));
          throw new Error(`peer ${peer.slice(0, 8)}: ${smokeErrStr(e)}`);
        }
        if (!resp.ok) {
          console.warn(`[SmokeStore] cache: peer ${peer.slice(0, 12)} returned HTTP ${resp.status}`);
          throw new Error(`peer ${peer.slice(0, 8)} returned ${resp.status}`);
        }
        const data = new Uint8Array(await resp.arrayBuffer());
        const mb = (data.byteLength / 1_048_576).toFixed(2);
        console.log(`[SmokeStore] cache: received ${mb} MB from ${peer.slice(0, 12)} in ${(performance.now() - t0).toFixed(0)} ms`);
        return data;
      };

      const data = await Promise.race([Promise.any(candidates.map(fetchFromPeer)), timeout]);

      // Route to OPFS if large, smoke FS if small
      if (data.byteLength >= OPFS_WRITE_THRESHOLD) {
        await this.writeToOPFS(cidStr, data);
      } else {
        await this.fs.write(blockPath, data);
      }
    }

    await this.fs.write(`/cached/${cidStr}`, new Uint8Array(0));
    if (uploaderPub) {
      await this.fs.write(`/cached-meta/${cidStr}`,
        new TextEncoder().encode(JSON.stringify({ uploaderPub })));
    }
  }

  async getCachedMeta(cidStr: string): Promise<{ uploaderPub?: string } | null> {
    this.assertStarted();
    try {
      if (!(await this.fs.exists(`/cached-meta/${cidStr}`))) return null;
      const bytes = await this.fs.read(`/cached-meta/${cidStr}`);
      return JSON.parse(new TextDecoder().decode(bytes)) as { uploaderPub?: string };
    } catch { return null; }
  }

  /** Register a callback invoked when a block arrives via the push (POST) path. */
  setBlockPushHandler(fn: (cid: string, uploaderPub: string | undefined) => void): void {
    this.blockPushHandler = fn;
  }

  /**
   * Write the /cached/ marker (and optional meta) without fetching the block.
   * Used after a push-receive — the block is already stored; only the marker is missing.
   */
  async markCached(cid: string, uploaderPub?: string): Promise<void> {
    this.assertStarted();
    await this.fs.write(`/cached/${cid}`, new Uint8Array(0));
    if (uploaderPub) {
      await this.fs.write(`/cached-meta/${cid}`,
        new TextEncoder().encode(JSON.stringify({ uploaderPub })));
    }
  }

  /**
   * Read a block from local storage only (smoke FS + OPFS). Returns null if not present.
   * Used by StorageManager.pushBlocksToProviders to read blocks before pushing.
   */
  async getBlock(cid: string): Promise<Uint8Array | null> {
    this.assertStarted();
    if (await this.fs.exists(`/blocks/${cid}`)) {
      return this.fs.read(`/blocks/${cid}`);
    }
    const opfsFile = await this.readFromOPFS(cid);
    if (opfsFile) return new Uint8Array(await opfsFile.arrayBuffer());
    return null;
  }

  /**
   * Push a block to a peer's smoke HTTP server via outbound WebRTC.
   * Outbound WebRTC succeeds even from mobile behind strict NAT (mobile→desktop),
   * whereas inbound connections (desktop→mobile pull) fail.
   */
  async pushBlock(peerSmokeAddr: string, cid: string, data: Uint8Array, uploaderPub?: string, timeoutMs = 60_000): Promise<void> {
    this.assertStarted();
    const qs = uploaderPub ? `?uploaderPub=${encodeURIComponent(uploaderPub)}` : '';
    const url = `http://${peerSmokeAddr}:${SMOKE_BLOCK_PORT}/block/${cid}${qs}`;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`push timeout after ${timeoutMs}ms`)), timeoutMs));
    const push = async (): Promise<void> => {
      let resp: Response;
      try {
        resp = await this.network.Http.fetch(url, {
          method: 'POST',
          body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        });
      } catch (e) {
        throw new Error(`push ${peerSmokeAddr.slice(0, 8)}: ${smokeErrStr(e)}`);
      }
      if (!resp.ok) throw new Error(`push ${peerSmokeAddr.slice(0, 8)} returned ${resp.status}`);
    };
    await Promise.race([push(), timeout]);
  }

  async fetchBlockFromProvider(smokeAddr: string, cidStr: string, timeoutMs = 8_000): Promise<Uint8Array> {
    this.assertStarted();
    const url = `http://${smokeAddr}:${SMOKE_BLOCK_PORT}/block/${cidStr}`;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`spot-check timeout after ${timeoutMs}ms`)), timeoutMs));
    const fetch = async (): Promise<Uint8Array> => {
      let resp: Response;
      try { resp = await this.network.Http.fetch(url); }
      catch (e) { throw new Error(`spot-check peer ${smokeAddr.slice(0, 8)}: ${smokeErrStr(e)}`); }
      if (!resp.ok) throw new Error(`spot-check peer ${smokeAddr.slice(0, 8)} returned ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    };
    return Promise.race([fetch(), timeout]);
  }

  async uncache(cidStr: string): Promise<void> {
    this.assertStarted();
    try { await this.fs.delete(`/cached/${cidStr}`); } catch { /* already removed */ }
  }

  /** Delete a block from all local storage (smoke FS + OPFS + cache markers + chunk index). */
  async deleteBlock(cidStr: string): Promise<void> {
    this.assertStarted();
    // Uploader's node: cascade to OPFS chunks via chunk-index
    const chunkCids = await this.loadChunkIndex(cidStr);
    if (chunkCids) {
      for (const cid of chunkCids) await this.deleteFromOPFS(cid);
      try { await this.fs.delete(`/chunk-index/${cidStr}`); } catch { /* already gone */ }
    }
    // Caching node: cascade to sub-CIDs via cache-group index
    const groupCids = await this.loadCacheGroup(cidStr);
    if (groupCids) {
      for (const cid of groupCids) {
        await this.deleteFromOPFS(cid);
        try { await this.fs.delete(`/blocks/${cid}`); } catch { /* already gone */ }
        try { await this.fs.delete(`/cached/${cid}`); } catch { /* already gone */ }
        try { await this.fs.delete(`/cached-meta/${cid}`); } catch { /* already gone */ }
      }
      try { await this.fs.delete(`/cache-groups/${cidStr}`); } catch { /* already gone */ }
    }
    await this.deleteFromOPFS(cidStr);
    try { await this.fs.delete(`/blocks/${cidStr}`); } catch { /* already gone */ }
    try { await this.fs.delete(`/cached/${cidStr}`); } catch { /* already gone */ }
    try { await this.fs.delete(`/cached-meta/${cidStr}`); } catch { /* already gone */ }
  }

  async isCached(cidStr: string): Promise<boolean> {
    this.assertStarted();
    try { return await this.fs.exists(`/cached/${cidStr}`); } catch { return false; }
  }

  async listCached(): Promise<string[]> {
    this.assertStarted();
    try { return await this.fs.readdir('/cached'); } catch { return []; }
  }

  /** Delete all files cached for serving other nodes' content. Leaves own uploaded blocks intact. */
  async clearCached(): Promise<number> {
    this.assertStarted();
    const cids = await this.listCached();

    // Build the set of sub-CIDs using the most reliable source available per root CID.
    // Priority: (1) /cache-groups/ saved at cache time, (2) /chunk-index/ (uploader's node),
    // (3) meta JSON parsing (public files, fallback for old caches without a group entry).
    const knownSubCids = new Set<string>();
    for (const cid of cids) {
      const group = await this.loadCacheGroup(cid);
      if (group) {
        for (const c of group) knownSubCids.add(c);
        continue;
      }
      const chunks = await this.loadChunkIndex(cid);
      if (chunks) {
        for (const c of chunks) knownSubCids.add(c);
        continue;
      }
      try {
        const raw = await this.fs.read(`/blocks/${cid}`);
        if (raw) {
          const parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
          if (typeof parsed.contentCid === 'string') knownSubCids.add(parsed.contentCid);
          if (Array.isArray(parsed.streamChunks)) {
            for (const chunk of parsed.streamChunks as Array<Record<string, unknown>>) {
              if (typeof chunk.cid === 'string') knownSubCids.add(chunk.cid);
            }
          }
        }
      } catch { /* not a JSON meta block — raw content CID, skip */ }
    }

    let fileCount = 0;
    for (const cid of cids) {
      if (!knownSubCids.has(cid)) {
        await this.deleteBlock(cid).catch(() => {});
        fileCount++;
      } else {
        // Sub-CID: delete its block/OPFS data and markers; root deleteBlock won't reach it
        // on caching nodes (no chunk-index to cascade from).
        await this.deleteFromOPFS(cid).catch(() => {});
        await this.fs.delete(`/blocks/${cid}`).catch(() => {});
        await this.fs.delete(`/cached/${cid}`).catch(() => {});
        await this.fs.delete(`/cached-meta/${cid}`).catch(() => {});
      }
    }
    return fileCount;
  }

  /** Wipe all stored content — own blocks AND cached files. Used on testnet reset. */
  async clearAllContent(): Promise<void> {
    this.assertStarted();
    for (const dir of ['/blocks', '/cached', '/cached-meta', '/chunk-index', '/cache-groups'] as const) {
      try {
        const names = await this.fs.readdir(dir);
        for (const name of names) await this.fs.delete(`${dir}/${name}`).catch(() => {});
      } catch { /* dir may not exist */ }
    }
    // Clear OPFS large-file chunks
    if (this.opfsBlocks) {
      try {
        for await (const [name] of (this.opfsBlocks as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
          await this.opfsBlocks.removeEntry(name).catch(() => {});
        }
      } catch { /* OPFS may be empty */ }
    }
  }

  /** Estimate local storage used in bytes (smoke FS blocks + OPFS large blocks). */
  async storageUsedBytes(): Promise<number> {
    this.assertStarted();
    let total = 0;
    // Smoke FS
    try {
      const names = await this.fs.readdir('/blocks');
      for (const name of names) {
        try {
          const s = await this.fs.stat(`/blocks/${name}`);
          if (s.type === 'file') total += s.size;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    // OPFS
    if (this.opfsBlocks) {
      try {
        for await (const [, handle] of (this.opfsBlocks as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
          if (handle.kind === 'file') {
            const file = await (handle as FileSystemFileHandle).getFile();
            total += file.size;
          }
        }
      } catch { /* skip */ }
    }
    return total;
  }

  private assertStarted(): void {
    if (!this.started) throw new Error('SmokeStore not started - call start() first');
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
  return out;
}
