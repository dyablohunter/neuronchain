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
 * initial peer discovery — no application data passes through it.
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
// gossipsub's OutboundStream calls pipe(pushable, rawStream) — it-pipe checks
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
// addPeer() to throw before pushing to outboundInflightQueue — so no streams form.
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
 * is empty, and the node starts completely isolated — no relay connection, no gossipsub
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

/** Bootstrap relay multiaddresses — always includes /p2p/<peerId> suffix. */
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
  if (relayInfo) return [relayInfo.bootstrapAddr];
  if (typeof window === 'undefined') return [`/dns4/localhost/tcp/9090/ws`];
  return [];
}

// ── GossipSub topic helpers ───────────────────────────────────────────────────

function topicBlocks(network: string, synapse: number): string {
  return `neuronchain/${network}/blocks/${synapse}`;
}
function topicVotes(network: string): string { return `neuronchain/${network}/votes`; }
function topicAccounts(network: string): string { return `neuronchain/${network}/accounts`; }
function topicInbox(network: string, pubShort: string): string { return `neuronchain/${network}/inbox/${pubShort}`; }
function topicGeneration(network: string): string { return `neuronchain/${network}/generation`; }
function topicStorageReceipts(network: string): string { return `neuronchain/${network}/storage/receipts`; }
function topicStoragePinRequests(network: string): string { return `neuronchain/${network}/storage/pin-requests`; }

const enc = new TextEncoder();
const dec = new TextDecoder();
function encode(obj: unknown): Uint8Array { return enc.encode(JSON.stringify(obj)); }
function decode<T>(data: Uint8Array): T { return JSON.parse(dec.decode(data)) as T; }

// ── IndexedDB schema ──────────────────────────────────────────────────────────

interface NeuronDB {
  blocks: AccountBlock & { id?: string };
  accounts: Record<string, unknown> & { pub: string };
  keyblobs: Record<string, unknown> & { pub: string };
  contracts: Record<string, unknown> & { id: string };
  votes: Vote & { id?: string };
}

async function openNeuronDB(network: string): Promise<IDBPDatabase<NeuronDB>> {
  return openDB<NeuronDB>(`neuronchain-${network}`, 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('blocks'))    db.createObjectStore('blocks',    { keyPath: 'hash' });
      if (!db.objectStoreNames.contains('accounts'))  db.createObjectStore('accounts',  { keyPath: 'pub' });
      if (!db.objectStoreNames.contains('keyblobs'))  db.createObjectStore('keyblobs',  { keyPath: 'pub' });
      if (!db.objectStoreNames.contains('contracts')) db.createObjectStore('contracts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('votes')) {
        const vs = db.createObjectStore('votes', { autoIncrement: true });
        vs.createIndex('byBlock', 'blockHash');
      }
    },
  });
}

// ── Known operators (mainnet governance) ─────────────────────────────────────

export const KNOWN_OPERATORS: string[] = [];

// ── Main class ────────────────────────────────────────────────────────────────

export class Libp2pNetwork extends EventEmitter {
  /** The underlying libp2p node — exposed so Helia can share it instead of creating its own */
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

  constructor(network: string) {
    super();
    this.network = network;
    this.loadGeneration();
  }

  private get genKey(): string { return `neuronchain_generation_${this.network}`; }
  private loadGeneration(): void { try { this.generation = parseInt(localStorage.getItem(this.genKey) || '0', 10) || 0; } catch { this.generation = 0; } }
  private saveGeneration(): void { try { localStorage.setItem(this.genKey, String(this.generation)); } catch {} }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    this.db = await openNeuronDB(this.network);

    const relayInfo = await fetchRelayInfo();
    if (!relayInfo) console.warn('[Libp2p] Could not fetch relay info — bootstrap will be skipped');
    const bootstrapList = buildBootstrapList(relayInfo);

    // Build directPeers for gossipsub — forces a gossipsub stream to the relay
    // regardless of mesh formation heuristics. Without this, gossipsub streams
    // never form and no messages flow between browser peers.
    const gsDirectPeers = relayInfo ? [{
      id: peerIdFromString(relayInfo.peerId),
      addrs: [multiaddr(relayInfo.bootstrapAddr.replace(`/p2p/${relayInfo.peerId}`, ''))],
    }] : [];

    this.libp2p = await createLibp2p({
      transports: [
        // Patch dialFilter: the default uses exactMatch which rejects http-path
        // multiaddrs (used to proxy the relay through Vite). Use matches() instead.
        (() => {
          const factory = webSockets({ allowInsecureConnections: true });
          return (components: Parameters<typeof factory>[0]) => {
            const t = factory(components);
            (t as unknown as Record<string, unknown>).dialFilter =
              (mas: import('@multiformats/multiaddr').Multiaddr[]) =>
                mas.filter(ma => WsMatcher.matches(ma) || WssMatcher.matches(ma));
            return t;
          };
        })(),
        webRTC(),
        circuitRelayTransport({ discoverRelays: 2 }),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [
        bootstrap({ list: bootstrapList, timeout: 3000 }),
      ],
      services: {
        pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false, directPeers: gsDirectPeers, runOnLimitedConnection: true, directConnectTicks: 10 }),
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
    const pubsub = this.libp2p.services.pubsub as ReturnType<typeof gossipsub>;
    for (let i = 0; i < NUM_SYNAPSES; i++) pubsub.subscribe(topicBlocks(this.network, i));
    pubsub.subscribe(topicVotes(this.network));
    pubsub.subscribe(topicAccounts(this.network));
    pubsub.subscribe(topicGeneration(this.network));
    pubsub.subscribe(topicStorageReceipts(this.network));
    pubsub.subscribe(topicStoragePinRequests(this.network));

    pubsub.addEventListener('message', (evt) => {
      const msg = evt.detail;
      this.handleMessage(msg.topic, msg.data).catch(console.error);
    });

    this.running = true;
    this.startedAt = Date.now();
    this.emit('network:started', this.peerId);

    // Fallback: if the relay wasn't up during fetchRelayInfo (all retries exhausted),
    // try one more time after the node has been running for 3s. This covers the edge
    // case where the relay process was still initialising when start() was called —
    // common when the page reloads immediately after a testnet reset.
    if (!relayInfo) {
      setTimeout(async () => {
        if (!this.running) return;
        const info = await fetchRelayInfo(3, 2000);
        if (info) {
          try {
            await this.libp2p.dial(multiaddr(info.bootstrapAddr));
          } catch { /* ignore — bootstrap will retry automatically */ }
        }
      }, 3000);
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.libp2p?.stop();
    this.trackedPeers.clear();
    this.emit('network:stopped');
  }

  // ── Message handler ───────────────────────────────────────────────────────

  private async handleMessage(topic: string, data: Uint8Array): Promise<void> {
    if (topic === topicGeneration(this.network)) {
      const msg = decode<{ generation?: number; signature?: string; operatorPub?: string }>(data);
      if (typeof msg.generation !== 'number' || msg.generation <= this.generation) return;
      if (this.network === 'mainnet') {
        if (!msg.signature || !msg.operatorPub || !KNOWN_OPERATORS.includes(msg.operatorPub)) return;
        const result = await verifySignature(msg.signature, msg.operatorPub);
        if (result !== `generation:${msg.generation}`) return;
      }
      this.generation = msg.generation;
      this.saveGeneration();
      // Mirror what clearAll() does locally: wipe DB and dedup sets so this peer
      // accepts the reset-generation blocks from other peers.
      //
      // Without this, if Device A resets (gen 0→1) and Device B later also resets
      // (gen 1→2), Device A would receive the gen=2 message and update its counter
      // in localStorage, but keep stale blocks in IndexedDB and processedBlocks.
      // On next startup Device A would publish those blocks with _gen=1, and Device B
      // (now gen=2) would drop them via the `raw._gen < this.generation` guard.
      // Wiping here + emitting generation:changed (→ node.ts → ledger.reset() →
      // location.reload()) ensures both devices land at the same clean state.
      try {
        await this.db.clear('blocks');
        await this.db.clear('accounts');
        await this.db.clear('votes');
        await this.db.clear('contracts');
      } catch { /* ignore */ }
      this.processedBlocks.clear();
      this.processedVotes.clear();
      this.emit('generation:changed', this.generation);
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
        // that block:received only fires ONCE per hash — autoReceive in node.ts
        // therefore also only fires once. If the recipient's node missed that window
        // (e.g. gossipsub mesh wasn't formed yet), it will never auto-receive from
        // re-broadcasts. That's why sweepUnclaimedReceives() in node.ts periodically
        // scans ledger.unclaimedSends directly instead of relying on this event.
        if (block && !this.processedBlocks.has(block.hash)) {
          this.processedBlocks.add(block.hash);
          this.capSet(this.processedBlocks);
          await this.db.put('blocks', block as NeuronDB['blocks']);
          this.emit('block:received', block);
        }
        return;
      }
    }

    if (topic === topicVotes(this.network)) {
      const raw = decode<Record<string, unknown>>(data);
      if (raw.blockHash === null || raw.voterPub === null || raw.signature === null) return;
      const vote = raw as Vote;
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

    if (topic === topicStoragePinRequests(this.network)) {
      const req = decode<Record<string, unknown>>(data);
      if (req.cid && req.uploaderPub && Array.isArray(req.targetProviders)) {
        this.emit('storage:pin-request', req);
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
    this.db.put('blocks', block as NeuronDB['blocks']).catch(() => {});
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
      (this.libp2p.services.pubsub as ReturnType<typeof gossipsub>).subscribe(topic);
    }
    this.on('inbox:signal', (sig: unknown) => {
      const s = sig as { sender?: string; blockHash?: string; amount?: number; timestamp?: number; signature?: string };
      if (s.sender && s.blockHash) callback({ sender: s.sender, blockHash: s.blockHash, amount: s.amount ?? 0, timestamp: s.timestamp ?? 0, signature: s.signature });
    });
  }

  // ── Persistence (accounts, keyblobs, contracts) ───────────────────────────

  saveAccount(pub: string, account: Record<string, unknown>): void {
    if (!this.running) return;
    const data = { ...account, _gen: this.generation };
    this.db.put('accounts', data as NeuronDB['accounts']).catch(() => {});
    this.publish(topicAccounts(this.network), data);
  }

  saveContract(id: string, contract: Record<string, unknown>): void {
    if (!this.running) return;
    this.db.put('contracts', { ...contract, id } as NeuronDB['contracts']).catch(() => {});
  }

  saveKeyBlob(pub: string, blob: Record<string, unknown>): void {
    if (!this.running) return;
    this.db.put('keyblobs', { ...blob, pub } as NeuronDB['keyblobs']).catch(() => {});
  }

  async loadKeyBlob(pub: string): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.db.get('keyblobs', pub);
      return result ? (result as Record<string, unknown>) : null;
    } catch { return null; }
  }

  async findKeyBlobByUsername(username: string): Promise<Record<string, unknown> | null> {
    try {
      const all = await this.db.getAll('keyblobs');
      const found = all.find(b => (b as Record<string, unknown>).username === username);
      return found ? (found as Record<string, unknown>) : null;
    } catch { return null; }
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
        const a = acc as Record<string, unknown>;
        if (a.pub && a.username) map.set(String(a.pub), a);
      }
    } catch { /* empty db is fine */ }
    return map;
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
      const all = await this.db.getAll('blocks');
      return (all as AccountBlock[]).filter(b => b.accountPub === accountPub).sort((a, b) => a.index - b.index);
    } catch { return []; }
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

  // ── Reset ─────────────────────────────────────────────────────────────────

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
      this.publish(topicGeneration(this.network), { generation: this.generation });
    }

    try {
      await this.db.clear('blocks');
      await this.db.clear('accounts');
      await this.db.clear('votes');
      await this.db.clear('contracts');
      // Keep keyblobs — user still needs to recover their account
    } catch { /* ignore */ }

    this.processedBlocks.clear();
    this.processedVotes.clear();
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private publish(topic: string, obj: unknown): void {
    if (!this.running) return;
    const pubsub = this.libp2p.services.pubsub as ReturnType<typeof gossipsub>;
    pubsub.publish(topic, encode(obj)).catch((e: unknown) => {
      // "not enough peers" is expected when offline — suppress
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

  private serializeBlock(block: AccountBlock): Record<string, unknown> {
    return {
      hash: block.hash, accountPub: block.accountPub, index: block.index,
      type: block.type, previousHash: block.previousHash, balance: block.balance,
      timestamp: block.timestamp, signature: block.signature,
      recipient: block.recipient || '', amount: block.amount ?? 0,
      sendBlockHash: block.sendBlockHash || '', sendFrom: block.sendFrom || '',
      receiveAmount: block.receiveAmount ?? 0, faceMapHash: block.faceMapHash || '',
      contractData: block.contractData || '', contentCid: block.contentCid || '',
    };
  }

  private static readonly VALID_BLOCK_TYPES = new Set([
    'open', 'send', 'receive', 'deploy', 'call',
    'storage-register', 'storage-deregister', 'storage-heartbeat', 'storage-reward',
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

  publishPinRequest(request: Record<string, unknown>): void {
    if (!this.running) return;
    this.publish(topicStoragePinRequests(this.network), request);
  }

  watchPinRequests(callback: (request: Record<string, unknown>) => void): void {
    this.on('storage:pin-request', callback as (data: unknown) => void);
  }

  getStats(): NetworkStats {
    return { peerId: this.peerId, peerCount: this.trackedPeers.size, isRunning: this.running, synapses: NUM_SYNAPSES, startedAt: this.startedAt };
  }

  isRunning(): boolean { return this.running; }
}
