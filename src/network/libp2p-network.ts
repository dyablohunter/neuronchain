/**
 * libp2p P2P network layer.
 *
 * Architecture:
 *  - GossipSub for real-time block/vote/account/inbox propagation
 *  - IndexedDB (via idb) for local persistence so nodes resume from local state
 *  - Kademlia DHT (client mode in browser) for decentralised peer discovery
 *  - WebRTC + circuit-relay-v2 for browser-to-browser connections (no central relay on data path)
 *  - WebSocket transport to connect to bootstrap relay node(s)
 *
 * The relay server (relay-server.js) only assists with NAT traversal and
 * initial peer discovery - no application data passes through it.
 */

import { createLibp2p } from 'libp2p';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { WebSockets as WsMatcher, WebSocketsSecure as WssMatcher } from '@multiformats/multiaddr-matcher';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { kadDHT } from '@libp2p/kad-dht';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { bootstrap } from '@libp2p/bootstrap';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { openDB, IDBPDatabase } from 'idb';
import { AbstractMessageStream } from '@libp2p/utils';
import { GossipSub } from '@chainsafe/libp2p-gossipsub';

// ── Fix A: libp2p stream API mismatch with it-pipe ────────────────────────────
// New libp2p streams (AbstractMessageStream) have Symbol.asyncIterator + send()
// but NOT the .sink / .source duplex interface that it-pipe expects.
// gossipsub's OutboundStream calls pipe(pushable, rawStream) - it-pipe checks
// isDuplex(rawStream) which needs .sink and .source; without them it throws TypeError
// that is silently swallowed, leaving streamsOutbound empty and no messages flowing.
if (!('source' in AbstractMessageStream.prototype)) {
  Object.defineProperty(AbstractMessageStream.prototype, 'source', {
    get() { return this; },
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(AbstractMessageStream.prototype, 'sink', {
    get() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this as unknown as { send: (d: Uint8Array) => void } & AsyncIterable<Uint8Array>;
      return async (source: AsyncIterable<Uint8Array>) => {
        for await (const chunk of source) {
          self.send(chunk);
        }
      };
    },
    configurable: true,
    enumerable: false,
  });
}

// ── Fix B: multiaddr.tuples() API mismatch in GossipSub.addPeer ──────────────
// gossipsub 14.x calls multiaddr.tuples() for IP scoring but libp2p's internal
// multiaddr objects (different class instance) don't have this method, causing
// addPeer() to throw before pushing to outboundInflightQueue - so no streams form.
const _gsOrigAddPeer = (GossipSub.prototype as unknown as Record<string, unknown>)['addPeer'] as (p: unknown, d: unknown, a: unknown) => void;
(GossipSub.prototype as unknown as Record<string, unknown>)['addPeer'] = function(
  this: Record<string, unknown>,
  peerId: unknown,
  direction: unknown,
  addr: unknown,
) {
  try {
    return _gsOrigAddPeer.call(this, peerId, direction, addr);
  } catch {
    const id = (peerId as { toString(): string }).toString();
    const peers = this['peers'] as Map<string, unknown>;
    if (!peers.has(id)) {
      peers.set(id, peerId);
      (this['score'] as { addPeer?: (id: string) => void } | undefined)?.addPeer?.(id);
      const outbound = this['outbound'] as Map<string, boolean>;
      if (!outbound.has(id)) {
        outbound.set(id, direction === 'outbound');
      }
    }
  }
};

// ── Fix C: onIncomingStream handler signature mismatch ───────────────────────
// libp2p (this version) calls registered protocol handlers as handler(stream, connection)
// with two positional args, but gossipsub 14.x expects handler({ stream, connection })
// as a single destructured object. Without this fix, connection.remotePeer is undefined,
// createInboundStream is never called, and no inbound streams or mesh form.
const _gsOrigOIS = (GossipSub.prototype as unknown as Record<string, unknown>)['onIncomingStream'] as (arg: unknown) => void;
(GossipSub.prototype as unknown as Record<string, unknown>)['onIncomingStream'] = function(
  this: unknown,
  streamOrObj: unknown,
  connection: unknown,
) {
  if (connection !== undefined && (streamOrObj as Record<string, unknown>)?.['connection'] === undefined) {
    return _gsOrigOIS.call(this, { stream: streamOrObj, connection });
  }
  return _gsOrigOIS.call(this, streamOrObj);
};

import { EventEmitter } from '../core/events';
import { AccountBlock } from '../core/dag-block';
import { Vote } from '../core/vote';
import { verifySignature } from '../core/crypto';
import { LockoutNotice, lockoutPayload } from '../core/pin-crypto';

export const NUM_SYNAPSES = 4;

export interface NetworkStats {
  peerId: string;
  peerCount: number;
  isRunning: boolean;
  synapses: number;
  startedAt: number | null;
}

export function getSynapseIndex(accountPub: string): number {
  let hash = 0;
  for (let i = 0; i < accountPub.length; i++) {
    hash = ((hash << 5) - hash + accountPub.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % NUM_SYNAPSES;
}

interface RelayInfo {
  peerId: string;
  bootstrapAddr: string;
}

/**
 * Fetch the relay's peer ID and bootstrap address from /relay-info.
 * The peer ID is required for @libp2p/bootstrap to actually dial (it silently
 * skips multiaddrs without /p2p/<id>).  The bootstrap addr is also used as
 * a gossipsub directPeer so gossipsub always opens a stream to the relay.
 */
/**
 * Fetch relay peer ID and bootstrap address from the Vite-proxied /relay-info endpoint.
 *
 * Retries are essential: when the page reloads immediately after a testnet reset,
 * the relay process (spawned by the Vite plugin) may not have finished starting yet.
 * Without retries, fetchRelayInfo returns null, bootstrapList is empty, gsDirectPeers
 * is empty, and the node starts completely isolated - no relay connection, no gossipsub
 * streams, no sync. The retry loop (5× at 1.5s) covers the typical relay startup window.
 *
 * If retries are exhausted a background dial is attempted 3s after node.start()
 * (see the fallback block below createLibp2p). That covers the edge case where the
 * relay was still initialising when the retry window closed.
 */
async function fetchRelayInfo(retries = 5, delayMs = 1500): Promise<RelayInfo | null> {
  if (typeof window === 'undefined') return null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch('/relay-info', { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = await res.json() as { peerId?: string };
      if (!json.peerId) throw new Error('no peerId');

      const host = window.location.hostname;
      const isLocal = host === 'localhost' || host === '127.0.0.1';
      const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const bootstrapAddr = isLocal
        ? `/dns4/localhost/tcp/9090/ws/p2p/${json.peerId}`
        : `/dns4/${host}/tcp/${port}/${wsProto}/http-path/relay-ws/p2p/${json.peerId}`;

      return { peerId: json.peerId, bootstrapAddr };
    } catch {
      if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return null;
}

// Injected at build time via vite.config.ts define; empty array when not set.
declare const __BOOTSTRAP_ADDRS__: string[] | undefined;

/** Bootstrap relay multiaddresses - always includes /p2p/<peerId> suffix. */
function buildBootstrapList(relayInfo: RelayInfo | null): string[] {
  if (typeof window !== 'undefined') {
    try {
      const custom = localStorage.getItem('neuronchain_bootstrap');
      if (custom) {
        const parsed = JSON.parse(custom) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch { /* ignore */ }
  }
  // Build-time baked list (set via __BOOTSTRAP_ADDRS__ in vite.config.ts define)
  if (typeof __BOOTSTRAP_ADDRS__ !== 'undefined' && Array.isArray(__BOOTSTRAP_ADDRS__) && __BOOTSTRAP_ADDRS__.length > 0) {
    return relayInfo ? [relayInfo.bootstrapAddr, ...__BOOTSTRAP_ADDRS__] : __BOOTSTRAP_ADDRS__;
  }
  // Community relays cached from previous sessions
  const communityRelays = lsLoadRelayAddrs().filter(a => !relayInfo || a !== relayInfo.bootstrapAddr);
  if (relayInfo) return [relayInfo.bootstrapAddr, ...communityRelays];
  if (communityRelays.length > 0) return communityRelays;
  if (typeof window === 'undefined') return [`/dns4/localhost/tcp/9090/ws`];
  return [];
}

// ── Protocol version ─────────────────────────────────────────────────────────
// Nodes on a different PROTOCOL_VERSION will not share GossipSub topics and
// will therefore never corrupt each other's ledger state, even if they connect
// to the same relay and use the same network name.
export const PROTOCOL_VERSION = 'v1';

// ── GossipSub topic helpers ───────────────────────────────────────────────────

function topicBlocks(network: string, synapse: number): string {
  return `neuronchain/${PROTOCOL_VERSION}/${network}/blocks/${synapse}`;
}
function topicVotes(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/votes`; }
function topicAccounts(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/accounts`; }
function topicInbox(network: string, pubShort: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/inbox/${pubShort}`; }
function topicGeneration(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/generation`; }
function topicStorageReceipts(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/storage/receipts`; }
function topicStorageCacheRequests(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/storage/cache-requests`; }
function topicStorageDeleteRequests(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/storage/delete-requests`; }
function topicStorageReplaceRequests(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/storage/replace-requests`; }
function topicLockouts(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/lockouts`; }
function topicKeyBlobs(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/keyblobs`; }
function topicBlobRequests(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/blob-requests`; }
function topicPeerAddrs(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/peer-addrs`; }
function topicRelays(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/relays`; }
function topicSnapshots(network: string): string { return `neuronchain/${PROTOCOL_VERSION}/${network}/snapshots`; }

// localStorage bootstrap cache — addresses only, for buildBootstrapList (pre-DB)
const KNOWN_RELAYS_KEY = 'neuronchain_known_relays';
function lsLoadRelayAddrs(): string[] {
  try { return JSON.parse(localStorage.getItem(KNOWN_RELAYS_KEY) || '[]') as string[]; } catch { return []; }
}
function lsSaveRelayAddrs(addrs: string[]): void {
  try { localStorage.setItem(KNOWN_RELAYS_KEY, JSON.stringify(addrs.slice(-30))); } catch {}
}
function lsAddRelayAddr(addr: string): void {
  const existing = lsLoadRelayAddrs();
  if (!existing.includes(addr)) { existing.push(addr); lsSaveRelayAddrs(existing); }
}

const RELAY_FAIL_EVICT = 3; // consecutive failures before eviction
const RELAY_STALE_MS = 48 * 60 * 60 * 1000; // 48 h without contact → evict

const enc = new TextEncoder();
const dec = new TextDecoder();
function encode(obj: unknown): Uint8Array { return enc.encode(JSON.stringify(obj)); }
function decode<T>(data: Uint8Array): T { return JSON.parse(dec.decode(data)) as T; }

// ── IndexedDB schema ──────────────────────────────────────────────────────────

export interface TrackedCidRecord {
  cid: string;
  ownerPub: string;
  additionalCids: string[];
  confirmedProviders: string[];
  lastDistributed: number;
}

export interface KnownRelayRecord {
  addr: string;         // full multiaddr — keyPath
  peerId: string;       // extracted from /p2p/<id> suffix
  lastSeen: number;     // Unix ms — last successful connection or fresh announcement
  failCount: number;    // consecutive dial failures; evicted at RELAY_FAIL_EVICT
  announcerPub: string; // account pub that signed the announcement
}

interface NeuronDB {
  blocks: AccountBlock & { id?: string; _blockVersion?: number };
  accounts: Record<string, unknown> & { pub: string };
  keyblobs: Record<string, unknown> & { pub: string };
  contracts: Record<string, unknown> & { id: string };
  votes: Vote & { id?: string };
  trackedCids: TrackedCidRecord;
  knownRelays: KnownRelayRecord;
}

async function openNeuronDB(network: string): Promise<IDBPDatabase<NeuronDB>> {
  return openDB<NeuronDB>(`neuronchain-${network}`, 7, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 2) {
        const bs = db.createObjectStore('blocks', { keyPath: 'hash' });
        bs.createIndex('byAccount', 'accountPub');       // P9: O(1) account chain lookup
        bs.createIndex('byBlockVersion', '_blockVersion'); // A5: incremental block resync
        const as = db.createObjectStore('accounts',  { keyPath: 'pub' });
        as.createIndex('byVersion', '_version');      // P4: O(changed) incremental resync
        if (!db.objectStoreNames.contains('keyblobs'))  db.createObjectStore('keyblobs',  { keyPath: 'pub' });
        if (!db.objectStoreNames.contains('contracts')) db.createObjectStore('contracts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('votes')) {
          const vs = db.createObjectStore('votes', { autoIncrement: true });
          vs.createIndex('byBlock', 'blockHash');
        }
      }
      // v3: trackedCids for persistent storage redundancy tracking
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains('trackedCids')) {
          db.createObjectStore('trackedCids', { keyPath: 'cid' });
        }
      }
      // v4: byAccount index on blocks store for O(1) per-account chain queries
      if (oldVersion >= 2 && oldVersion < 4) {
        try {
          const store = transaction.objectStore('blocks');
          if (!store.indexNames.contains('byAccount')) {
            store.createIndex('byAccount', 'accountPub');
          }
        } catch { /* store may not exist on very fresh databases */ }
      }
      // v5: byVersion index on accounts store for O(changed) incremental resync
      if (oldVersion >= 2 && oldVersion < 5) {
        try {
          const store = transaction.objectStore('accounts');
          if (!store.indexNames.contains('byVersion')) {
            store.createIndex('byVersion', '_version');
          }
        } catch { /* store may not exist on very fresh databases */ }
      }
      // v6: byBlockVersion index on blocks store for A5 incremental block resync
      if (oldVersion >= 2 && oldVersion < 6) {
        try {
          const store = transaction.objectStore('blocks');
          if (!store.indexNames.contains('byBlockVersion')) {
            store.createIndex('byBlockVersion', '_blockVersion');
          }
        } catch { /* store may not exist on very fresh databases */ }
      }
      // v7: knownRelays store — community relay registry with liveness tracking
      if (oldVersion < 7) {
        if (!db.objectStoreNames.contains('knownRelays')) {
          db.createObjectStore('knownRelays', { keyPath: 'addr' });
        }
      }
    },
  });
}

// ── Known operators (mainnet governance) ─────────────────────────────────────

export const KNOWN_OPERATORS: string[] = [];

// ── Main class ────────────────────────────────────────────────────────────────

export class Libp2pNetwork extends EventEmitter {
  /** The underlying libp2p node */
  libp2p!: Awaited<ReturnType<typeof createLibp2p>>;
  private db!: IDBPDatabase<NeuronDB>;
  private network: string;
  running = false;
  private startedAt: number | null = null;
  private peerId = '';
  private trackedPeers: Set<string> = new Set();
  private processedBlocks: Set<string> = new Set();
  private processedVotes: Set<string> = new Set();
  private generation = 0;
  private watchedInboxes: Set<string> = new Set();
  private static readonly MAX_PROCESSED = 50_000;
  /** Decentralised lockout notices: accountPub → latest LockoutNotice */
  private lockoutNotices: Map<string, LockoutNotice> = new Map();
  private static readonly MAX_LOCKOUTS = 10_000;
  /** L2: peer addrs with timestamp for TTL eviction */
  knownPeerAddrs: Map<string, { addrs: string[]; updatedAt: number }> = new Map();
  private static readonly PEER_ADDR_TTL_MS = 10 * 60 * 1000; // 10 minutes
  /** H4: per-peer token bucket - peerId → { tokens, lastRefill } */
  private peerBuckets: Map<string, { tokens: number; lastRefill: number }> = new Map();
  private static readonly BUCKET_CAPACITY = 50;
  private static readonly BUCKET_REFILL_PER_SEC = 10;
  private peerAddrTimer: ReturnType<typeof setInterval> | null = null;
  private peerAddrBroadcastDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Our own smoke Hub address - included in peer-addrs broadcasts for peer discovery */
  private smokeAddr = '';
  /** P4: monotonic counter stamped on every IDB account write; enables range-query incremental resync */
  private accountVersionCounter = 0;
  /** A5: monotonic counter stamped on every IDB block write; enables range-query incremental block resync */
  private blockVersionCounter = 0;
  /** Community relay registry — addr → record (mirrors IDB knownRelays store) */
  private knownRelayMap: Map<string, KnownRelayRecord> = new Map();

  constructor(network: string) {
    super();
    this.network = network;
    this.loadGeneration();
    this.loadAccountVersion();
    this.loadBlockVersion();
  }

  private get genKey(): string { return `neuronchain_generation_${this.network}`; }
  private loadGeneration(): void { try { this.generation = parseInt(localStorage.getItem(this.genKey) || '0', 10) || 0; } catch { this.generation = 0; } }
  private saveGeneration(): void { try { localStorage.setItem(this.genKey, String(this.generation)); } catch {} }

  private get accVerKey(): string { return `neuronchain_acc_ver_${this.network}`; }
  private loadAccountVersion(): void { try { this.accountVersionCounter = parseInt(localStorage.getItem(this.accVerKey) || '0', 10) || 0; } catch { this.accountVersionCounter = 0; } }
  private saveAccountVersion(): void { try { localStorage.setItem(this.accVerKey, String(this.accountVersionCounter)); } catch {} }
  /** Returns the current monotonic account version (highest version written to IDB this session). */
  getAccountVersionCounter(): number { return this.accountVersionCounter; }

  private get blkVerKey(): string { return `neuronchain_blk_ver_${this.network}`; }
  private loadBlockVersion(): void { try { this.blockVersionCounter = parseInt(localStorage.getItem(this.blkVerKey) || '0', 10) || 0; } catch { this.blockVersionCounter = 0; } }
  private saveBlockVersion(): void { try { localStorage.setItem(this.blkVerKey, String(this.blockVersionCounter)); } catch {} }
  /** Returns the current monotonic block version (highest version written to IDB this session). */
  getBlockVersionCounter(): number { return this.blockVersionCounter; }

  // ── Community relay registry ──────────────────────────────────────────────

  private static peerIdFromAddr(addr: string): string {
    const m = addr.match(/\/p2p\/([^/]+)$/);
    return m ? m[1] : '';
  }

  private async loadKnownRelaysFromDB(): Promise<void> {
    try {
      const records = await (this.db as IDBPDatabase<any>).getAll('knownRelays') as KnownRelayRecord[];
      const now = Date.now();
      for (const r of records) {
        if (r.failCount >= RELAY_FAIL_EVICT || now - r.lastSeen > RELAY_STALE_MS) {
          await (this.db as IDBPDatabase<any>).delete('knownRelays', r.addr);
        } else {
          this.knownRelayMap.set(r.addr, r);
          lsAddRelayAddr(r.addr);
        }
      }
    } catch { /* fresh DB */ }
  }

  async upsertKnownRelay(addr: string, announcerPub: string): Promise<void> {
    const peerId = Libp2pNetwork.peerIdFromAddr(addr);
    if (!peerId) return;
    const existing = this.knownRelayMap.get(addr);
    const record: KnownRelayRecord = {
      addr, peerId,
      lastSeen: Date.now(),
      failCount: 0,
      announcerPub: existing?.announcerPub || announcerPub,
    };
    this.knownRelayMap.set(addr, record);
    lsAddRelayAddr(addr);
    try { await (this.db as IDBPDatabase<any>).put('knownRelays', record); } catch { /* ignore */ }
    this.emit('relays:updated');
  }

  async markRelayFailed(addr: string): Promise<void> {
    const record = this.knownRelayMap.get(addr);
    if (!record) return;
    record.failCount++;
    if (record.failCount >= RELAY_FAIL_EVICT || Date.now() - record.lastSeen > RELAY_STALE_MS) {
      this.knownRelayMap.delete(addr);
      try { await (this.db as IDBPDatabase<any>).delete('knownRelays', addr); } catch { /* ignore */ }
      const addrs = lsLoadRelayAddrs().filter(a => a !== addr);
      lsSaveRelayAddrs(addrs);
      this.emit('relays:updated');
    } else {
      try { await (this.db as IDBPDatabase<any>).put('knownRelays', record); } catch { /* ignore */ }
    }
  }

  getKnownRelays(): KnownRelayRecord[] {
    return [...this.knownRelayMap.values()];
  }

  async publishRelayAnnouncement(addr: string, keys: { pub: string; priv: string; epub: string; epriv: string }): Promise<void> {
    if (!this.running) return;
    const peerId = Libp2pNetwork.peerIdFromAddr(addr);
    if (!peerId) throw new Error('Address must include /p2p/<peerId> suffix');
    const { signData } = await import('../core/crypto');
    const timestamp = Date.now();
    const payload = `relay-announce:${addr}:${timestamp}`;
    const signature = await signData(payload, keys);
    this.publish(topicRelays(this.network), { addr, peerId, timestamp, pub: keys.pub, signature });
    await this.upsertKnownRelay(addr, keys.pub);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    this.db = await openNeuronDB(this.network);
    await this.loadKnownRelaysFromDB();

    const relayInfo = await fetchRelayInfo();
    if (!relayInfo) console.warn('[Libp2p] Could not fetch relay info - bootstrap will be skipped');
    const bootstrapList = buildBootstrapList(relayInfo);

    // Build directPeers for gossipsub - forces a gossipsub stream to the relay
    // regardless of mesh formation heuristics. Without this, gossipsub streams
    // never form and no messages flow between browser peers.
    const gsDirectPeers = relayInfo ? [{
      id: peerIdFromString(relayInfo.peerId),
      addrs: [multiaddr(relayInfo.bootstrapAddr.replace(`/p2p/${relayInfo.peerId}`, ''))],
    }] : [];

    this.libp2p = await createLibp2p({
      addresses: {
        // '/p2p-circuit' triggers the circuit-relay transport's listen() path,
        // which calls reservationStore.reserveRelay(). Without this entry the
        // pendingReservations array stays empty, the store considers "enough relays
        // found" (zero needed = zero required), and never makes a relay reservation -
        // leaving getMultiaddrs() empty and the node with no reachable address.
        listen: ['/p2p-circuit'],
      },
      transports: [
        // Patch dialFilter: the default uses exactMatch which rejects http-path
        // multiaddrs (used to proxy the relay through Vite). Use matches() instead.
        (() => {
          const factory = webSockets({ allowInsecureConnections: true } as Parameters<typeof webSockets>[0]);
          return (components: Parameters<typeof factory>[0]) => {
            const t = factory(components);
            (t as unknown as Record<string, unknown>).dialFilter =
              (mas: import('@multiformats/multiaddr').Multiaddr[]) =>
                mas.filter(ma => WsMatcher.matches(ma) || WssMatcher.matches(ma));
            return t;
          };
        })(),
        webRTC(),
        circuitRelayTransport(),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [
        bootstrap({ list: bootstrapList, timeout: 3000 }),
      ],
      services: {
        pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false, directPeers: gsDirectPeers, runOnLimitedConnection: true, directConnectTicks: 10 }) as unknown as () => unknown,
        dht: kadDHT({ clientMode: true }),
        identify: identify(),
        ping: ping(),
      },
    });

    this.peerId = this.libp2p.peerId.toString();

    // Peer events
    this.libp2p.addEventListener('peer:connect', (evt) => {
      const id = evt.detail.toString();
      if (!this.trackedPeers.has(id)) {
        this.trackedPeers.add(id);
        this.emit('peer:connected', id);
      }
    });
    this.libp2p.addEventListener('peer:disconnect', (evt) => {
      const id = evt.detail.toString();
      this.trackedPeers.delete(id);
      this.emit('peer:disconnected', id);
    });

    await this.libp2p.start();

    // Subscribe to GossipSub topics
    const pubsub = this.libp2p.services.pubsub as unknown as GossipSub;
    for (let i = 0; i < NUM_SYNAPSES; i++) pubsub.subscribe(topicBlocks(this.network, i));
    pubsub.subscribe(topicVotes(this.network));
    pubsub.subscribe(topicAccounts(this.network));
    pubsub.subscribe(topicGeneration(this.network));
    pubsub.subscribe(topicStorageReceipts(this.network));
    pubsub.subscribe(topicStorageCacheRequests(this.network));
    pubsub.subscribe(topicStorageDeleteRequests(this.network));
    pubsub.subscribe(topicStorageReplaceRequests(this.network));
    pubsub.subscribe(topicLockouts(this.network));
    pubsub.subscribe(topicKeyBlobs(this.network));
    pubsub.subscribe(topicBlobRequests(this.network));
    pubsub.subscribe(topicPeerAddrs(this.network));
    pubsub.subscribe(topicRelays(this.network));
    pubsub.subscribe(topicSnapshots(this.network));

    pubsub.addEventListener('message', (evt) => {
      const msg = evt.detail as { topic: string; data: Uint8Array; from?: { toString(): string } };
      const fromPeer: string = msg.from?.toString() ?? '';
      this.handleMessage(msg.topic, msg.data, fromPeer).catch(console.error);
    });

    // When a remote peer subscribes to the peer-addrs topic it means a new node
    // is joining and wants to discover peer addresses. Re-broadcast immediately so
    // they don't have to wait for the next heartbeat. This is the most reliable
    // trigger because it fires on the publisher's side exactly when a new subscriber
    // appears in the GossipSub mesh - regardless of whether there's a direct libp2p
    // connection between the two browser peers.
    pubsub.addEventListener('subscription-change', (evt: Event) => {
      const detail = (evt as CustomEvent<{ subscriptions: Array<{ topic: string; subscribe: boolean }> }>).detail;
      const interested = detail?.subscriptions?.some(
        s => s.topic === topicPeerAddrs(this.network) && s.subscribe
      );
      if (interested) {
        this.scheduleBroadcastPeerAddrs(500);
      }
    });

    this.running = true;
    this.startedAt = Date.now();
    this.emit('network:started', this.peerId);

    // Broadcast peer-addrs as soon as our own circuit-relay address appears.
    this.libp2p.addEventListener('self:peer:update', () => this.scheduleBroadcastPeerAddrs(500));

    // Re-broadcast at staggered delays when a peer connects.
    // GossipSub streams take 2-8s to form; retrying at 6s and 16s ensures at
    // least one broadcast lands after the stream is established.
    this.libp2p.addEventListener('peer:connect', () => {
      setTimeout(() => this.broadcastPeerAddrs(), 2_000);
      setTimeout(() => this.broadcastPeerAddrs(), 6_000);
      setTimeout(() => this.broadcastPeerAddrs(), 16_000);
    });

    // Heartbeat every 15s as a fallback for any missed events.
    this.peerAddrTimer = setInterval(() => this.broadcastPeerAddrs(), 15_000);

    // Fallback: if the relay wasn't up during fetchRelayInfo (all retries exhausted),
    // try one more time after the node has been running for 3s. This covers the edge
    // case where the relay process was still initialising when start() was called -
    // common when the page reloads immediately after a testnet reset.
    if (!relayInfo) {
      setTimeout(async () => {
        if (!this.running) return;
        const info = await fetchRelayInfo(3, 2000);
        if (info) {
          try {
            await this.libp2p.dial(multiaddr(info.bootstrapAddr));
            lsAddRelayAddr(info.bootstrapAddr);
          } catch { /* ignore - bootstrap will retry automatically */ }
        }
      }, 3000);
    } else {
      lsAddRelayAddr(relayInfo.bootstrapAddr);
    }

    // Dial all community relays from IDB and gossip known relays to new peers
    setTimeout(async () => {
      if (!this.running) return;
      const primaryAddr = relayInfo?.bootstrapAddr;
      for (const r of this.knownRelayMap.values()) {
        if (r.addr === primaryAddr) continue;
        try { await this.libp2p.dial(multiaddr(r.addr)); } catch { /* unreachable at startup */ }
      }
      // Announce own relay + all known community relays so new peers can learn them
      if (relayInfo) {
        this.publish(topicRelays(this.network), { addr: relayInfo.bootstrapAddr, peerId: relayInfo.peerId, timestamp: Date.now(), pub: '', signature: '' });
      }
      for (const r of this.knownRelayMap.values()) {
        this.publish(topicRelays(this.network), { addr: r.addr, peerId: r.peerId, timestamp: r.lastSeen, pub: r.announcerPub, signature: '' });
      }
    }, 5000);

    // Re-gossip community relays every 20 min so new nodes that join later learn about them
    setInterval(() => {
      if (!this.running) return;
      for (const r of this.knownRelayMap.values()) {
        this.publish(topicRelays(this.network), { addr: r.addr, peerId: r.peerId, timestamp: r.lastSeen, pub: r.announcerPub, signature: '' });
      }
    }, 20 * 60 * 1000);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.peerAddrTimer) { clearInterval(this.peerAddrTimer); this.peerAddrTimer = null; }
    if (this.peerAddrBroadcastDebounce) { clearTimeout(this.peerAddrBroadcastDebounce); this.peerAddrBroadcastDebounce = null; }
    await this.libp2p?.stop();
    this.trackedPeers.clear();
    this.emit('network:stopped');
  }

  private scheduleBroadcastPeerAddrs(delayMs: number): void {
    if (!this.running) return;
    if (this.peerAddrBroadcastDebounce) return; // already scheduled
    this.peerAddrBroadcastDebounce = setTimeout(() => {
      this.peerAddrBroadcastDebounce = null;
      this.broadcastPeerAddrs();
    }, delayMs);
  }

  /** Set our smoke Hub address so it is included in peer-addrs broadcasts. */
  setSmokeAddr(addr: string): void {
    this.smokeAddr = addr;
    if (this.running) this.scheduleBroadcastPeerAddrs(200);
  }

  private broadcastPeerAddrs(): void {
    if (!this.running) return;
    const all = (this.libp2p?.getMultiaddrs?.() ?? []).map(ma => ma.toString());
    const addrs = all.filter(a => a.includes('p2p-circuit'));
    if (addrs.length === 0) { console.warn('[Libp2p] No circuit-relay addrs yet - relay reservation may not have completed'); return; }
    const msg: Record<string, unknown> = { peerId: this.peerId, addrs };
    if (this.smokeAddr) msg.smokeAddr = this.smokeAddr;
    this.publish(topicPeerAddrs(this.network), msg);
  }

  // ── Message handler ───────────────────────────────────────────────────────

  private async handleMessage(topic: string, data: Uint8Array, fromPeer = ''): Promise<void> {
    // H4: per-peer token bucket rate limiting - drop if peer exceeds burst capacity
    if (fromPeer && !this.consumePeerToken(fromPeer)) return;
    if (topic === topicGeneration(this.network)) {
      const msg = decode<{ generation?: number; signature?: string; operatorPub?: string; resetAt?: number }>(data);
      if (typeof msg.generation !== 'number' || msg.generation <= this.generation) return;
      if (this.network === 'mainnet') {
        if (!msg.signature || !msg.operatorPub || !KNOWN_OPERATORS.includes(msg.operatorPub)) return;
        const result = await verifySignature(msg.signature, msg.operatorPub);
        if (result !== `generation:${msg.generation}`) return;
      }
      this.generation = msg.generation;
      this.saveGeneration();
      // isReset = true only when clearAll() triggered this - it stamps resetAt.
      // publishLocalData() re-broadcasts without resetAt, so peers syncing their
      // generation counter don't have their data wiped.
      const isReset = typeof msg.resetAt === 'number' && (Date.now() - msg.resetAt < 10 * 60 * 1000);
      if (isReset) {
        // Real testnet reset: wipe all stored data so old-gen blocks don't re-enter
        try {
          await this.db.clear('blocks');
          await this.db.clear('accounts');
          await this.db.clear('votes');
          await this.db.clear('contracts');
          await this.db.clear('trackedCids');
        } catch { /* ignore */ }
        this.processedBlocks.clear();
        this.processedVotes.clear();
      }
      this.emit('generation:changed', isReset);
      return;
    }

    for (let i = 0; i < NUM_SYNAPSES; i++) {
      if (topic === topicBlocks(this.network, i)) {
        const raw = decode<Record<string, unknown>>(data);
        if (raw.hash === null || raw.accountPub === null || raw.signature === null) return;
        if (typeof raw._gen === 'number' && raw._gen < this.generation) return;
        const block = this.deserializeBlock(raw);
        // processedBlocks dedup is intentional: it prevents gossipsub relay loops
        // (a block we published coming back to us from a peer). The side effect is
        // that block:received only fires ONCE per hash - autoReceive in node.ts
        // therefore also only fires once. If the recipient's node missed that window
        // (e.g. gossipsub mesh wasn't formed yet), it will never auto-receive from
        // re-broadcasts. That's why sweepUnclaimedReceives() in node.ts periodically
        // scans ledger.unclaimedSends directly instead of relying on this event.
        if (block && !this.processedBlocks.has(block.hash)) {
          // Enforce decentralised lockout: drop blocks from accounts under active lockout
          const lockout = this.lockoutNotices.get(block.accountPub);
          if (lockout && lockout.lockedUntil > Date.now()) {
            return; // Silently drop - account is locked out by peer consensus
          }
          this.processedBlocks.add(block.hash);
          this.capSet(this.processedBlocks);
          this.blockVersionCounter++;
          this.saveBlockVersion();
          await this.db.put('blocks', { ...block, _blockVersion: this.blockVersionCounter } as NeuronDB['blocks']);
          this.emit('block:received', block);
        }
        return;
      }
    }

    if (topic === topicVotes(this.network)) {
      const raw = decode<Record<string, unknown>>(data);
      if (raw.blockHash === null || raw.voterPub === null || raw.signature === null) return;
      const vote = raw as unknown as Vote;
      const key = `${vote.blockHash}:${vote.voterPub}`;
      if (vote.blockHash && vote.voterPub && !this.processedVotes.has(key)) {
        this.processedVotes.add(key);
        this.capSet(this.processedVotes);
        this.emit('vote:received', vote);
      }
      return;
    }

    if (topic === topicAccounts(this.network)) {
      const acc = decode<Record<string, unknown>>(data);
      if (acc.pub === null || acc.username === null) return;
      if (typeof acc._gen === 'number' && acc._gen < this.generation) return;
      if (acc.pub && acc.username) {
        // S5: unsigned gossip must not overwrite an existing account's verified data
        if (!acc._sig) {
          const existing = await this.db.get('accounts', String(acc.pub));
          if (existing && (existing as Record<string, unknown>)._sig) return;
        }
        await this.db.put('accounts', acc as NeuronDB['accounts']);
        this.emit('account:synced', acc);
      }
      return;
    }

    // Inbox topics are dynamic: neuronchain/{network}/inbox/{pubShort}
    if (topic.startsWith(`neuronchain/${this.network}/inbox/`)) {
      const sig = decode<{ sender?: string; blockHash?: string; amount?: number; timestamp?: number; signature?: string }>(data);
      if (sig.sender && sig.blockHash) {
        this.emit('inbox:signal', sig);
      }
      return;
    }

    if (topic === topicStorageReceipts(this.network)) {
      const receipt = decode<Record<string, unknown>>(data);
      if (receipt.providerPub && receipt.requesterPub && receipt.cid) {
        this.emit('storage:receipt', receipt);
      }
      return;
    }

    if (topic === topicStorageCacheRequests(this.network)) {
      const req = decode<Record<string, unknown>>(data);
      if (req.cid && req.uploaderPub && Array.isArray(req.targetProviders)) {
        this.emit('storage:cache-request', req);
      }
      return;
    }

    if (topic === topicStorageDeleteRequests(this.network)) {
      const req = decode<Record<string, unknown>>(data);
      if (Array.isArray(req.cids) && req.ownerPub && req.signature) {
        this.emit('storage:delete-request', req);
      }
      return;
    }

    if (topic === topicStorageReplaceRequests(this.network)) {
      const req = decode<Record<string, unknown>>(data);
      if (req.oldCid && req.newCid && req.ownerPub && req.signature) {
        this.emit('storage:replace-request', req);
      }
      return;
    }

    if (topic === topicLockouts(this.network)) {
      const notice = decode<LockoutNotice>(data);
      if (
        notice.accountPub &&
        typeof notice.failedAttempts === 'number' &&
        typeof notice.lockedUntil === 'number' &&
        typeof notice.timestamp === 'number' &&
        Date.now() - notice.timestamp < 5 * 60 * 1000 // reject stale notices >5min old
      ) {
        // Require valid ECDSA signature from the account holder - prevents peers faking lockouts
        if (!notice.signature) return;
        const verified = await verifySignature(notice.signature, notice.accountPub);
        if (verified !== lockoutPayload(notice)) return;

        const existing = this.lockoutNotices.get(notice.accountPub);
        // Only update if this notice has a higher attempt count or later lockout
        if (!existing || notice.failedAttempts >= existing.failedAttempts) {
          if (this.lockoutNotices.size >= Libp2pNetwork.MAX_LOCKOUTS) {
            // Evict the oldest/least-locked entry
            const oldestKey = this.lockoutNotices.keys().next().value;
            if (oldestKey) this.lockoutNotices.delete(oldestKey);
          }
          this.lockoutNotices.set(notice.accountPub, notice);
          this.emit('lockout:received', notice);
        }
      }
      return;
    }

    if (topic === topicKeyBlobs(this.network)) {
      const blob = decode<Record<string, unknown>>(data);
      if (blob.pub && blob.encryptedKeys && blob.username) {
        // Verify linkedAnchor against on-chain account to reject tampered blobs.
        // Anchor = SHA-256(encryptedKeys + ":" + faceMapHash + ":" + pub).
        // Skip if account not yet synced locally (can't verify yet - accept optimistically).
        if (blob.linkedAnchor && blob.faceMapHash) {
          const onChain = await this.db.get('accounts', blob.pub as string).catch(() => null);
          if (onChain) {
            const onChainAnchor = (onChain as Record<string, unknown>).linkedAnchor;
            if (onChainAnchor && typeof onChainAnchor === 'string') {
              const input = `${blob.encryptedKeys}:${blob.faceMapHash}:${blob.pub}`;
              const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
              const computed = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
              if (computed !== onChainAnchor) return; // anchor mismatch - discard
            }
          }
        }

        // Only overwrite if the incoming blob is newer - prevents a stale gossip
        // from another node from silently reverting a locally-updated blob.
        const existing = await this.db.get('keyblobs', blob.pub as string).catch(() => null);
        const incomingTs = typeof blob.updatedAt === 'number' ? blob.updatedAt : 0;
        const existingTs = existing && typeof (existing as Record<string, unknown>).updatedAt === 'number'
          ? (existing as Record<string, unknown>).updatedAt as number : 0;
        if (incomingTs >= existingTs) {
          await this.db.put('keyblobs', blob as NeuronDB['keyblobs']).catch(() => {});
        }
        this.emit('blob:received', blob);
      }
      return;
    }

    if (topic === topicBlobRequests(this.network)) {
      const req = decode<{ username: string }>(data);
      if (req.username) {
        // Respond if we have this blob locally
        const all = await this.db.getAll('keyblobs').catch(() => [] as NeuronDB['keyblobs'][]);
        const found = all.find(b => (b as Record<string, unknown>).username === req.username);
        if (found) {
          this.publish(topicKeyBlobs(this.network), found);
        }
      }
      return;
    }

    if (topic === topicPeerAddrs(this.network)) {
      const msg = decode<{ peerId?: string; addrs?: string[]; smokeAddr?: string }>(data);
      if (msg.peerId && msg.peerId !== this.peerId && Array.isArray(msg.addrs) && msg.addrs.length > 0) {
        // L2: evict stale entries before inserting
        const now = Date.now();
        for (const [pid, entry] of this.knownPeerAddrs) {
          if (now - entry.updatedAt > Libp2pNetwork.PEER_ADDR_TTL_MS) this.knownPeerAddrs.delete(pid);
        }
        this.knownPeerAddrs.set(msg.peerId, { addrs: msg.addrs, updatedAt: now });
        this.emit('peer:addrs', { peerId: msg.peerId, addrs: msg.addrs, smokeAddr: msg.smokeAddr });
      }
      return;
    }

    // Community relay announcements — verify signature when present, upsert and dial
    if (topic === topicRelays(this.network)) {
      const msg = decode<{ addr?: string; peerId?: string; timestamp?: number; pub?: string; signature?: string }>(data);
      if (!msg.addr || typeof msg.addr !== 'string') return;
      if (!Libp2pNetwork.peerIdFromAddr(msg.addr)) return;
      // Verify signature when the message was explicitly signed by an account holder
      if (msg.signature && msg.pub && msg.timestamp) {
        const payload = `relay-announce:${msg.addr}:${msg.timestamp}`;
        const result = await verifySignature(msg.signature, msg.pub);
        if (result !== payload) return;
      }
      await this.upsertKnownRelay(msg.addr, msg.pub || '');
      this.emit('relay:discovered', msg.addr);
      try { await this.libp2p.dial(multiaddr(msg.addr)); } catch { /* unreachable, skip */ }
      return;
    }

    // A8: snapshot announcements - emit so node.ts can decide whether to fetch and apply
    if (topic === topicSnapshots(this.network)) {
      const msg = decode<{ cid?: string; sizeBytes?: number; epochBlock?: string; timestamp?: number }>(data);
      if (msg.cid && typeof msg.cid === 'string' && msg.epochBlock) {
        this.emit('snapshot:announced', { cid: msg.cid, sizeBytes: msg.sizeBytes ?? 0, epochBlock: msg.epochBlock });
      }
      return;
    }
  }

  // ── Publishing ────────────────────────────────────────────────────────────

  publishBlock(block: AccountBlock): void {
    if (!this.running) return;
    this.processedBlocks.add(block.hash);
    const data = this.serializeBlock(block);
    data._gen = this.generation;
    const topic = topicBlocks(this.network, getSynapseIndex(block.accountPub));
    this.publish(topic, data);
    this.blockVersionCounter++;
    this.saveBlockVersion();
    this.db.put('blocks', { ...block, _blockVersion: this.blockVersionCounter } as NeuronDB['blocks']).catch(() => {});
  }

  publishVote(vote: Vote): void {
    if (!this.running) return;
    const key = `${vote.blockHash}:${vote.voterPub}`;
    this.processedVotes.add(key);
    this.publish(topicVotes(this.network), {
      blockHash: vote.blockHash, voterPub: vote.voterPub,
      approve: vote.approve, stake: vote.stake,
      timestamp: vote.timestamp, signature: vote.signature,
      chainHeadHash: vote.chainHeadHash || '',
    });
  }

  publishLockout(notice: LockoutNotice): void {
    if (!this.running) return;
    // Store locally so our own blocks aren't affected during this session
    this.lockoutNotices.set(notice.accountPub, notice);
    this.publish(topicLockouts(this.network), notice);
  }

  /** Check if an account is currently under a decentralised lockout (held by any peer) */
  isLockedOut(accountPub: string): boolean {
    const notice = this.lockoutNotices.get(accountPub);
    return !!notice && notice.lockedUntil > Date.now();
  }

  /** A8: broadcast a snapshot announcement - peers can fetch the CID from SmokeStore. */
  publishSnapshot(cid: string, sizeBytes: number, epochBlock: string): void {
    if (!this.running) return;
    this.publish(topicSnapshots(this.network), { cid, sizeBytes, epochBlock, timestamp: Date.now() });
  }

  publishInboxSignal(recipientPub: string, senderPub: string, blockHash: string, amount: number, signature?: string): void {
    if (!this.running) return;
    const pubShort = recipientPub.slice(0, 16);
    this.publish(topicInbox(this.network, pubShort), { sender: senderPub, blockHash, amount, timestamp: Date.now(), signature: signature || '' });
  }

  watchInbox(recipientPub: string, callback: (signal: { sender: string; blockHash: string; amount: number; timestamp: number; signature?: string }) => void): void {
    if (this.watchedInboxes.has(recipientPub)) return;
    this.watchedInboxes.add(recipientPub);
    const pubShort = recipientPub.slice(0, 16);
    const topic = topicInbox(this.network, pubShort);
    if (this.running) {
      (this.libp2p.services.pubsub as unknown as GossipSub).subscribe(topic);
    }
    this.on('inbox:signal', (sig: unknown) => {
      const s = sig as { sender?: string; blockHash?: string; amount?: number; timestamp?: number; signature?: string };
      if (s.sender && s.blockHash) callback({ sender: s.sender, blockHash: s.blockHash, amount: s.amount ?? 0, timestamp: s.timestamp ?? 0, signature: s.signature });
    });
  }

  // ── Persistence (accounts, keyblobs, contracts) ───────────────────────────

  saveAccount(pub: string, account: Record<string, unknown>): void {
    if (!this.running) return;
    // P8: never persist or gossip the plaintext face descriptor
    const { faceDescriptor: _fd, ...clean } = account as Record<string, unknown> & { faceDescriptor?: unknown };
    // P4: stamp monotonic version so loadChangedAccounts can do a bounded range query
    this.accountVersionCounter++;
    this.saveAccountVersion();
    const data = { ...clean, _gen: this.generation, _version: this.accountVersionCounter };
    this.db.put('accounts', data as unknown as NeuronDB['accounts']).catch(() => {});
    this.publish(topicAccounts(this.network), data);
  }

  saveContract(id: string, contract: Record<string, unknown>): void {
    if (!this.running) return;
    this.db.put('contracts', { ...contract, id } as NeuronDB['contracts']).catch(() => {});
  }

  saveKeyBlob(pub: string, blob: Record<string, unknown>): Promise<void> {
    const entry = { ...blob, pub };
    const stored = this.db.put('keyblobs', entry as NeuronDB['keyblobs']).then(() => {}).catch(() => {});
    // Gossip the updated blob so other nodes can serve it during recovery.
    // With the combined-key scheme the blob no longer grants standalone access to private keys
    // (face + PIN are both required), so network-wide availability is safe.
    if (this.running) this.publish(topicKeyBlobs(this.network), entry);
    return stored;
  }

  async loadKeyBlob(pub: string): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.db.get('keyblobs', pub);
      return result ? (result as Record<string, unknown>) : null;
    } catch { return null; }
  }

  async findKeyBlobByUsername(username: string, timeoutMs = 6000): Promise<Record<string, unknown> | null> {
    // Fast path: local IDB
    try {
      const all = await this.db.getAll('keyblobs');
      const found = all.find(b => (b as Record<string, unknown>).username === username);
      if (found) return found as Record<string, unknown>;
    } catch { /* fall through */ }

    // Slow path: ask peers over GossipSub and wait for a response
    if (!this.running) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('blob:received', handler);
        resolve(null);
      }, timeoutMs);

      const handler = (...args: unknown[]) => {
        const blob = args[0] as Record<string, unknown>;
        if (blob && blob.username === username) {
          clearTimeout(timer);
          this.off('blob:received', handler);
          resolve(blob);
        }
      };

      this.on('blob:received', handler);
      this.publish(topicBlobRequests(this.network), { username });
    });
  }

  async loadAccount(pub: string): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.db.get('accounts', pub);
      return result ? (result as Record<string, unknown>) : null;
    } catch { return null; }
  }

  async loadAccounts(): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    try {
      const all = await this.db.getAll('accounts');
      for (const acc of all) {
        // P8: strip plaintext face descriptor on load so old IDB records don't re-gossip it
        const { faceDescriptor: _fd, ...a } = acc as Record<string, unknown> & { faceDescriptor?: unknown };
        if (a.pub && a.username) map.set(String(a.pub), a);
      }
    } catch { /* empty db is fine */ }
    return map;
  }

  /**
   * P4: Return only accounts written to IDB after `sinceVersion` (exclusive).
   * Uses the byVersion index so the IDB read is O(changed) instead of O(total accounts).
   */
  async loadChangedAccounts(sinceVersion: number): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all = await (this.db as IDBPDatabase<any>).getAllFromIndex(
        'accounts', 'byVersion', IDBKeyRange.lowerBound(sinceVersion, true),
      );
      for (const acc of all as Record<string, unknown>[]) {
        const { faceDescriptor: _fd, ...a } = acc as Record<string, unknown> & { faceDescriptor?: unknown };
        if (a.pub && a.username) map.set(String(a.pub), a);
      }
    } catch { /* index may not exist on old databases - caller falls back to loadAccounts */ }
    return map;
  }

  /**
   * A5: Return only blocks written to IDB after `sinceVersion` (exclusive).
   * Uses the byBlockVersion index - O(new blocks) instead of O(all blocks).
   */
  async loadBlocksSince(sinceVersion: number): Promise<AccountBlock[]> {
    try {
      const all = await (this.db as IDBPDatabase<any>).getAllFromIndex( // eslint-disable-line @typescript-eslint/no-explicit-any
        'blocks', 'byBlockVersion', IDBKeyRange.lowerBound(sinceVersion, true),
      );
      return (all as AccountBlock[]);
    } catch { return []; }
  }

  async loadAccountChains(): Promise<Map<string, AccountBlock[]>> {
    const chains = new Map<string, AccountBlock[]>();
    try {
      const all = await this.db.getAll('blocks');
      for (const b of all) {
        const block = b as AccountBlock;
        const chain = chains.get(block.accountPub) ?? [];
        chain.push(block);
        chains.set(block.accountPub, chain);
      }
      for (const [pub, chain] of chains) {
        chains.set(pub, chain.sort((a, b) => a.index - b.index));
      }
    } catch { /* empty */ }
    return chains;
  }

  async loadAccountChain(accountPub: string): Promise<AccountBlock[]> {
    try {
      // P9: use byAccount index for O(account-chain-length) instead of O(total-blocks) full scan
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all = await (this.db as IDBPDatabase<any>).getAllFromIndex('blocks', 'byAccount', accountPub);
      return (all as AccountBlock[]).sort((a, b) => a.index - b.index);
    } catch {
      // Fall back to full scan for databases that haven't completed the v4 upgrade yet
      try {
        const all = await this.db.getAll('blocks');
        return (all as AccountBlock[]).filter(b => b.accountPub === accountPub).sort((a, b) => a.index - b.index);
      } catch { return []; }
    }
  }

  async loadContracts(): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    try {
      const all = await this.db.getAll('contracts');
      for (const c of all) {
        const contract = c as Record<string, unknown>;
        if (contract.id) map.set(String(contract.id), contract);
      }
    } catch { /* empty */ }
    return map;
  }

  // ── P5: trackedCids persistence ───────────────────────────────────────────

  async saveTrackedCid(record: TrackedCidRecord): Promise<void> {
    try { await this.db.put('trackedCids', record); } catch { /* ignore */ }
  }

  async loadTrackedCids(): Promise<TrackedCidRecord[]> {
    try { return await this.db.getAll('trackedCids'); } catch { return []; }
  }

  async deleteTrackedCid(cid: string): Promise<void> {
    try { await this.db.delete('trackedCids', cid); } catch { /* ignore */ }
  }

  // ── Reset ─────────────────────────────────────────────────────────────────

  publishGeneration(): void {
    if (this.generation > 0) {
      this.publish(topicGeneration(this.network), { generation: this.generation });
    }
  }

  async clearAll(operatorKeys?: { pub: string; priv: string; epub: string; epriv: string }): Promise<void> {
    if (this.network === 'mainnet' && !operatorKeys) {
      console.error('[Libp2p] Mainnet clearAll requires operator keys');
      return;
    }

    this.generation++;
    this.saveGeneration();

    if (operatorKeys) {
      const { signData } = await import('../core/crypto');
      const payload = `generation:${this.generation}`;
      const signature = await signData(payload, operatorKeys);
      this.publish(topicGeneration(this.network), { generation: this.generation, signature, operatorPub: operatorKeys.pub });
    } else {
      this.publish(topicGeneration(this.network), { generation: this.generation, resetAt: Date.now() });
    }

    try {
      await this.db.clear('blocks');
      await this.db.clear('accounts');
      await this.db.clear('votes');
      await this.db.clear('contracts');
      // Keep keyblobs - user still needs to recover their account
    } catch { /* ignore */ }

    this.processedBlocks.clear();
    this.processedVotes.clear();
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** H4: consume one token from the peer's bucket; returns false if bucket is empty (rate-limited). */
  private consumePeerToken(peerId: string): boolean {
    const now = Date.now();
    let bucket = this.peerBuckets.get(peerId);
    if (!bucket) {
      bucket = { tokens: Libp2pNetwork.BUCKET_CAPACITY, lastRefill: now };
      this.peerBuckets.set(peerId, bucket);
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(Libp2pNetwork.BUCKET_CAPACITY, bucket.tokens + elapsed * Libp2pNetwork.BUCKET_REFILL_PER_SEC);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }

  private publish(topic: string, obj: unknown): void {
    if (!this.running) return;
    const pubsub = this.libp2p.services.pubsub as unknown as GossipSub;
    pubsub.publish(topic, encode(obj)).then(() => { /* ok */ }).catch((e: unknown) => {
      // "not enough peers" is expected when offline - suppress
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('not enough peers') && !msg.includes('no peers')) {
        console.warn('[Libp2p] publish error:', msg);
      }
    });
  }

  private capSet(set: Set<string>): void {
    if (set.size > Libp2pNetwork.MAX_PROCESSED) {
      const excess = set.size - Libp2pNetwork.MAX_PROCESSED;
      let count = 0;
      for (const v of set) { if (count++ < excess) set.delete(v); else break; }
    }
  }

  /** Allow a block hash to be processed again on next re-broadcast.
   *  Called by node.ts when addBlock fails so re-broadcast cycles can retry. */
  forgetBlock(hash: string): void {
    this.processedBlocks.delete(hash);
  }

  private serializeBlock(block: AccountBlock): Record<string, unknown> {
    return {
      hash: block.hash, accountPub: block.accountPub, index: block.index,
      type: block.type, previousHash: block.previousHash, balance: block.balance,
      timestamp: block.timestamp, signature: block.signature,
      recipient: block.recipient || '', amount: block.amount ?? 0,
      sendBlockHash: block.sendBlockHash || '', sendFrom: block.sendFrom || '',
      receiveAmount: block.receiveAmount ?? 0, faceMapHash: block.faceMapHash || '',
      contractData: block.contractData || '', contentCid: block.contentCid || '',
      updateData: block.updateData || '',
    };
  }

  private static readonly VALID_BLOCK_TYPES = new Set([
    'open', 'send', 'receive', 'deploy', 'call',
    'storage-register', 'storage-deregister', 'storage-heartbeat', 'storage-reward',
    'update',
  ]);

  private deserializeBlock(data: Record<string, unknown>): AccountBlock | null {
    try {
      if (!data.hash || !data.accountPub) return null;
      const type = String(data.type);
      if (!Libp2pNetwork.VALID_BLOCK_TYPES.has(type)) return null;
      return {
        hash: String(data.hash), accountPub: String(data.accountPub),
        index: Number(data.index), type: type as AccountBlock['type'],
        previousHash: String(data.previousHash), balance: Number(data.balance),
        timestamp: Number(data.timestamp), signature: String(data.signature),
        recipient: data.recipient ? String(data.recipient) : undefined,
        amount: data.amount ? Number(data.amount) : undefined,
        sendBlockHash: data.sendBlockHash ? String(data.sendBlockHash) : undefined,
        sendFrom: data.sendFrom ? String(data.sendFrom) : undefined,
        receiveAmount: data.receiveAmount ? Number(data.receiveAmount) : undefined,
        faceMapHash: data.faceMapHash ? String(data.faceMapHash) : undefined,
        contractData: data.contractData ? String(data.contractData) : undefined,
        contentCid: data.contentCid ? String(data.contentCid) : undefined,
        updateData: data.updateData ? String(data.updateData) : undefined,
      };
    } catch { return null; }
  }

  // ── Storage ledger messaging ──────────────────────────────────────────────

  publishStorageReceipt(receipt: Record<string, unknown>): void {
    if (!this.running) return;
    this.publish(topicStorageReceipts(this.network), receipt);
  }

  watchStorageReceipts(callback: (receipt: Record<string, unknown>) => void): void {
    this.on('storage:receipt', callback as (data: unknown) => void);
  }

  publishCacheRequest(request: Record<string, unknown>): void {
    if (!this.running) return;
    this.publish(topicStorageCacheRequests(this.network), request);
  }

  watchCacheRequests(callback: (request: Record<string, unknown>) => void): void {
    this.on('storage:cache-request', callback as (data: unknown) => void);
  }

  publishDeleteRequest(request: Record<string, unknown>): void {
    if (!this.running) return;
    this.publish(topicStorageDeleteRequests(this.network), request);
  }

  watchDeleteRequests(callback: (request: Record<string, unknown>) => void): void {
    this.on('storage:delete-request', callback as (data: unknown) => void);
  }

  publishReplaceRequest(request: Record<string, unknown>): void {
    if (!this.running) return;
    this.publish(topicStorageReplaceRequests(this.network), request);
  }

  watchReplaceRequests(callback: (request: Record<string, unknown>) => void): void {
    this.on('storage:replace-request', callback as (data: unknown) => void);
  }

  getStats(): NetworkStats {
    return { peerId: this.peerId, peerCount: this.trackedPeers.size, isRunning: this.running, synapses: NUM_SYNAPSES, startedAt: this.startedAt };
  }

  isRunning(): boolean { return this.running; }
}
