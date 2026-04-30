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

// ── GossipSub adapter interface ───────────────────────────────────────────────
// Passed in from node.ts after libp2p starts. Lets GossipSubHub route WebRTC
// ICE candidates through the existing GossipSub mesh instead of the relay WS,
// eliminating the relay server as a single point of failure for signaling.

export interface GossipSubAdapter {
  peerId: string;
  networkId: string;
  publish(topic: string, data: Uint8Array): void | Promise<void>;
  subscribe(topic: string): void;
  addEventListener(event: 'message', handler: EventListener): void;
  removeEventListener(event: 'message', handler: EventListener): void;
}

// ── GossipSubHub - WebRTC signaling over GossipSub ───────────────────────────
// Each node subscribes to a unique topic keyed by its libp2p peer ID.
// ICE candidates/SDP flow through the GossipSub mesh; no relay server needed.

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
      if (r instanceof Promise) r.catch(() => {}); // best-effort; ignore if no subscribers yet
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

// ── Custom Hub for cross-browser signaling (WebSocket fallback) ───────────────
// Used when no GossipSubAdapter is available (e.g. standalone / test mode).
// Connects to the relay server's /smoke-hub WebSocket endpoint.

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

  /**
   * Start the store. Pass a GossipSubAdapter (from libp2p) to route WebRTC
   * signaling through the existing GossipSub mesh instead of the relay WebSocket.
   * Falls back to the relay WebSocket hub when no adapter is provided.
   */
  async start(gsAdapter?: GossipSubAdapter): Promise<void> {
    if (this.started) return;

    const hub = gsAdapter ? new GossipSubHub(gsAdapter) : new RelayHub(this.hubUrl);
    this.network = new Network({ hub: hub as never });
    this.fs = await FileSystem.open('neuronchain-smoke-blocks');
    await this.fs.mkdir('/blocks');
    await this.fs.mkdir('/cached');
    await this.fs.mkdir('/cached-meta');

    // Serve locally-stored blocks to any peer that requests them via smoke Http.
    // Supports Range requests so spot-checkers can request arbitrary byte slices
    // without downloading the full block (proof-of-retrievability for large files).
    this.network.Http.listen({ port: SMOKE_BLOCK_PORT }, async (req: Request) => {
      const pathname = new URL(req.url).pathname;
      const cid = pathname.startsWith('/block/') ? pathname.slice('/block/'.length) : '';
      if (!cid) return new Response('Not Found', { status: 404 });
      try {
        if (!(await this.fs.exists(`/blocks/${cid}`))) return new Response('Not Found', { status: 404 });
        const data = await this.fs.read(`/blocks/${cid}`);

        // Range request - return only the requested byte slice (206 Partial Content)
        const rangeHeader = req.headers.get('range');
        if (rangeHeader) {
          const m = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
          if (m) {
            const start = parseInt(m[1], 10);
            const end = Math.min(parseInt(m[2], 10), data.byteLength - 1);
            // M2: reject ranges that are out-of-bounds or inverted
            if (start < 0 || start >= data.byteLength || start > end) {
              return new Response('Range Not Satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${data.byteLength}` } });
            }
            const slice = data.slice(start, end + 1);
            return new Response(
              slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer,
              { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${data.byteLength}` } },
            );
          }
        }

        return new Response(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      } catch {
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
    const mb = (data.byteLength / 1_048_576).toFixed(2);
    console.log(`[SmokeStore] store: computing CID for ${mb} MB`);
    const t0 = performance.now();
    const cid = await this.computeCID(data);
    console.log(`[SmokeStore] store: CID=${cid.slice(0, 20)}… writing to IDB (${mb} MB)`);
    try {
      await this.fs.write(`/blocks/${cid}`, data);
      console.log(`[SmokeStore] store: IDB write done in ${(performance.now() - t0).toFixed(0)} ms`);
    } catch (err) {
      console.error(`[SmokeStore] store: IDB write FAILED for ${mb} MB block — likely quota exceeded or size limit`, err);
      throw err;
    }
    return cid;
  }

  /**
   * Retrieve raw bytes by CID string.
   * Checks local storage first. If not found, tries priorityPeers first (known holders
   * of this specific CID), then all remaining peerFallbacks, all in parallel.
   * The first peer to respond wins and its data is cached locally.
   */
  async retrieve(cidStr: string, timeoutMs = 600_000, priorityPeers?: string[]): Promise<Uint8Array> {
    this.assertStarted();
    const path = `/blocks/${cidStr}`;
    const shortCid = cidStr.slice(0, 20);

    if (await this.fs.exists(path)) {
      console.log(`[SmokeStore] retrieve: local cache hit for ${shortCid}…`);
      const t0 = performance.now();
      const data = await this.fs.read(path);
      console.log(`[SmokeStore] retrieve: read ${(data.byteLength / 1_048_576).toFixed(2)} MB from IDB in ${(performance.now() - t0).toFixed(0)} ms`);
      return data;
    }

    // Priority peers first (confirmed holders of this CID), then all remaining fallbacks
    const prioritySet = new Set(priorityPeers ?? []);
    const peers = [
      ...Array.from(prioritySet),
      ...Array.from(this.peerFallbacks).filter(p => !prioritySet.has(p)),
    ];

    console.log(`[SmokeStore] retrieve: ${shortCid}… not local — trying ${peers.length} peer(s)`, peers.map(p => p.slice(0, 12)));

    if (peers.length === 0) {
      throw new Error(`[SmokeStore] Block not found locally and no peer fallbacks registered: ${shortCid}`);
    }

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[SmokeStore] retrieve timeout after ${timeoutMs}ms`)), timeoutMs),
    );

    const fetchFromPeer = async (peer: string): Promise<Uint8Array> => {
      const url = `http://${peer}:${SMOKE_BLOCK_PORT}/block/${cidStr}`;
      console.log(`[SmokeStore] retrieve: fetching ${shortCid}… from peer ${peer.slice(0, 12)}`);
      const t0 = performance.now();
      const resp = await this.network.Http.fetch(url);
      if (!resp.ok) throw new Error(`peer ${peer.slice(0, 8)} returned ${resp.status}`);
      console.log(`[SmokeStore] retrieve: got response from ${peer.slice(0, 12)} — reading arrayBuffer…`);
      const data = new Uint8Array(await resp.arrayBuffer());
      const mb = (data.byteLength / 1_048_576).toFixed(2);
      console.log(`[SmokeStore] retrieve: received ${mb} MB from ${peer.slice(0, 12)} in ${(performance.now() - t0).toFixed(0)} ms — writing to IDB`);
      try {
        await this.fs.write(path, data);
        console.log(`[SmokeStore] retrieve: IDB write done for ${mb} MB`);
      } catch (err) {
        console.error(`[SmokeStore] retrieve: IDB write FAILED for ${mb} MB — quota or size limit`, err);
        throw err;
      }
      return data;
    };

    return Promise.race([
      Promise.any(peers.map(fetchFromPeer)),
      timeout,
    ]);
  }

  /**
   * Verify that bytes actually hash to the given CID (proof of retrievability).
   * Since blocks are content-addressed, any mismatch means the provider served
   * tampered or corrupted data.
   */
  async verifyBlockIntegrity(cidStr: string, data: Uint8Array): Promise<boolean> {
    try {
      const expected = await this.computeCID(data);
      return expected === cidStr;
    } catch { return false; }
  }

  // ── Encrypted variants ─────────────────────────────────────────────────────

  async storeEncrypted(data: Uint8Array, keys: KeyPair): Promise<string> {
    const mb = (data.byteLength / 1_048_576).toFixed(2);
    console.log(`[SmokeStore] storeEncrypted: deriving AES key, encrypting ${mb} MB`);
    const t0 = performance.now();
    const aesKey = await deriveContentKey(keys);
    const encrypted = await encryptBytes(data, aesKey);
    console.log(`[SmokeStore] storeEncrypted: AES-256-GCM done in ${(performance.now() - t0).toFixed(0)} ms — encrypted size ${(encrypted.byteLength / 1_048_576).toFixed(2)} MB`);
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
  ): Promise<{ cid: string; meta: ContentMeta & { contentCid: string } }> {
    const mb = (data.byteLength / 1_048_576).toFixed(2);
    console.log(`[SmokeStore] storeWithMeta: "${meta.name ?? 'unnamed'}" ${mb} MB (${meta.mimeType}) — private`);
    if (data.byteLength > 50 * 1_048_576) {
      console.warn(`[SmokeStore] storeWithMeta: WARNING — ${mb} MB exceeds the ~50 MB single-object IDB limit. Store will likely fail or crash the tab.`);
    }
    const t0 = performance.now();
    const contentCid = await this.storeEncrypted(data, keys);
    const fullMeta: ContentMeta & { contentCid: string } = {
      ...meta, size: data.length, encrypted: true, timestamp: Date.now(), contentCid,
    };
    const metaCid = await this.storeJSON(fullMeta, keys);
    console.log(`[SmokeStore] storeWithMeta: done in ${(performance.now() - t0).toFixed(0)} ms — metaCid=${metaCid.slice(0, 20)}… contentCid=${contentCid.slice(0, 20)}…`);
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
    const mb = (data.byteLength / 1_048_576).toFixed(2);
    console.log(`[SmokeStore] storeWithMetaPublic: "${meta.name ?? 'unnamed'}" ${mb} MB (${meta.mimeType}) — public`);
    if (data.byteLength > 50 * 1_048_576) {
      console.warn(`[SmokeStore] storeWithMetaPublic: WARNING — ${mb} MB exceeds the ~50 MB single-object IDB limit. Store will likely fail or crash the tab.`);
    }
    const t0 = performance.now();
    const contentCid = await this.store(data);
    const fullMeta: ContentMeta & { contentCid: string } = {
      ...meta, size: data.length, encrypted: false, timestamp: Date.now(), contentCid,
    };
    const metaCid = await this.store(new TextEncoder().encode(JSON.stringify(fullMeta)));
    console.log(`[SmokeStore] storeWithMetaPublic: done in ${(performance.now() - t0).toFixed(0)} ms — metaCid=${metaCid.slice(0, 20)}… contentCid=${contentCid.slice(0, 20)}…`);
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
   * uploaderPub is persisted alongside the marker so delete requests can verify ownership.
   */
  async cache(cidStr: string, timeoutMs = 600_000, peerHostname?: string, uploaderPub?: string): Promise<void> {
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

      const data = await Promise.race([
        Promise.any(candidates.map(fetchFromPeer)),
        timeout,
      ]);
      await this.fs.write(blockPath, data);
    }

    await this.fs.write(`/cached/${cidStr}`, new Uint8Array(0));
    if (uploaderPub) {
      const meta = new TextEncoder().encode(JSON.stringify({ uploaderPub }));
      await this.fs.write(`/cached-meta/${cidStr}`, meta);
    }
  }

  /** Return cached metadata (e.g. uploaderPub) for a CID, or null if not present. */
  async getCachedMeta(cidStr: string): Promise<{ uploaderPub?: string } | null> {
    this.assertStarted();
    try {
      if (!(await this.fs.exists(`/cached-meta/${cidStr}`))) return null;
      const bytes = await this.fs.read(`/cached-meta/${cidStr}`);
      return JSON.parse(new TextDecoder().decode(bytes)) as { uploaderPub?: string };
    } catch { return null; }
  }

  /**
   * Fetch a specific block directly from a known provider by their smoke address.
   * Used by spot checks to target individual providers rather than broadcasting to all peers.
   */
  async fetchBlockFromProvider(smokeAddr: string, cidStr: string, timeoutMs = 8_000): Promise<Uint8Array> {
    this.assertStarted();
    const url = `http://${smokeAddr}:${SMOKE_BLOCK_PORT}/block/${cidStr}`;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`spot-check timeout after ${timeoutMs}ms`)), timeoutMs),
    );
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

  /** Permanently delete a block from local storage (blocks + cached markers). */
  async deleteBlock(cidStr: string): Promise<void> {
    this.assertStarted();
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
    if (!this.started) throw new Error('SmokeStore not started - call start() first');
  }
}
