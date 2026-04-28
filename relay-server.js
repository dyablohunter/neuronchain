/**
 * NeuronChain libp2p relay server
 *
 * Run with:  node relay-server.js
 *
 * This server provides three services:
 *   1. WebSocket listener at /p2p on port 9090 - browser entry point
 *   2. Circuit Relay v2 - lets browser peers reach each other through NAT
 *   3. Kademlia DHT server mode - peer routing for the network
 *
 * This relay is NOT on the data path:
 *   - Application messages (blocks, votes, accounts) pass peer-to-peer via GossipSub
 *   - Only circuit relay tunnels pass through here, only for NAT traversal
 *   - Once two browser peers discover each other, they upgrade to direct WebRTC
 *
 * Deploy multiple independent community relays to eliminate single-operator control.
 *
 * Environment variables:
 *   PORT         - WebSocket port (default: 9090)
 *   PEER_ID_FILE - path to persist peer ID across restarts (default: .relay-peer-id.json)
 */

import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@libp2p/yamux';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { ping } from '@libp2p/ping';
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { promises as fs } from 'fs';
import { createServer } from 'http';
import { AbstractMessageStream } from '@libp2p/utils';
import { GossipSub } from '@chainsafe/libp2p-gossipsub';

// ── Fix A: libp2p stream API mismatch with it-pipe ────────────────────────────
// New libp2p streams (AbstractMessageStream) have Symbol.asyncIterator + send()
// but NOT the .sink / .source duplex interface that it-pipe expects.
// gossipsub's OutboundStream calls pipe(pushable, rawStream) - it-pipe checks
// isDuplex(rawStream) = rawStream.sink != null && rawStream.source != null,
// which fails, causing a TypeError that is silently swallowed and leaving
// streamsOutbound empty (no messages flow).
Object.defineProperty(AbstractMessageStream.prototype, 'source', {
  get() { return this; },
  configurable: true,
  enumerable: false,
});
Object.defineProperty(AbstractMessageStream.prototype, 'sink', {
  get() {
    const self = this;
    return async (source) => {
      for await (const chunk of source) {
        self.send(chunk);
      }
    };
  },
  configurable: true,
  enumerable: false,
});

// ── Fix B: multiaddr.tuples() API mismatch in GossipSub.addPeer ──────────────
// gossipsub 14.x calls multiaddr.tuples() for IP scoring but libp2p's internal
// multiaddr objects (different class instance) don't have this method, causing
// addPeer() to throw before pushing to outboundInflightQueue - so no streams form.
// Patch: catch the error and add the peer manually without IP scoring.
const _origAddPeer = GossipSub.prototype.addPeer;
GossipSub.prototype.addPeer = function(peerId, direction, addr) {
  try {
    return _origAddPeer.call(this, peerId, direction, addr);
  } catch {
    const id = peerId.toString();
    if (!this.peers.has(id)) {
      this.peers.set(id, peerId);
      this.score?.addPeer(id);
      if (!this.outbound.has(id)) {
        this.outbound.set(id, direction === 'outbound');
      }
    }
  }
};

// ── Fix C: onIncomingStream handler signature mismatch ───────────────────────
// libp2p (this version) calls registered protocol handlers as handler(stream, connection)
// with two positional args, but gossipsub 14.x expects handler({ stream, connection })
// as a single destructured object. Without this fix, connection.remotePeer is undefined,
// createInboundStream is never called, and no inbound streams or mesh form.
const _origOnIncomingStream = GossipSub.prototype.onIncomingStream;
GossipSub.prototype.onIncomingStream = function(streamOrObj, connection) {
  if (connection !== undefined && streamOrObj?.connection === undefined) {
    return _origOnIncomingStream.call(this, { stream: streamOrObj, connection });
  }
  return _origOnIncomingStream.call(this, streamOrObj);
};

const PORT = parseInt(process.env.PORT || '9090', 10);
const PEER_ID_FILE = process.env.PEER_ID_FILE || '.relay-peer-id.json';

// ── Persistent peer ID ────────────────────────────────────────────────────────

async function loadOrCreatePrivKey() {
  try {
    const saved = JSON.parse(await fs.readFile(PEER_ID_FILE, 'utf8'));
    return privateKeyFromRaw(Buffer.from(saved.raw, 'base64'));
  } catch {
    const key = await generateKeyPair('Ed25519');
    await fs.writeFile(PEER_ID_FILE, JSON.stringify({
      raw: Buffer.from(key.raw).toString('base64'),
    }));
    console.log(`[Relay] Generated new peer ID: ${peerIdFromPrivateKey(key).toString()}`);
    return key;
  }
}

// ── Start relay ───────────────────────────────────────────────────────────────

async function main() {
  const privKey = await loadOrCreatePrivKey();
  const peerId = peerIdFromPrivateKey(privKey);

  const node = await createLibp2p({
    privateKey: privKey,
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${PORT}/ws`,
        `/ip4/0.0.0.0/tcp/${PORT + 1}`,
      ],
    },
    transports: [
      webSockets(),
      tcp(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false, runOnLimitedConnection: true }),
      identify: identify(),
      ping: ping(),
      relay: circuitRelayServer({
        // Allow browsers to use this node as a relay
        reservations: {
          maxReservations: 1024,
          reservationTtl: 2 * 60 * 60 * 1000, // 2h
          // Default data limit is 128 KB per circuit — far too small for BitSwap
          // block transfers (max IPFS block = 256 KB; a 10 MB file = ~40 blocks).
          // Set to 1 GB so BitSwap can freely exchange blocks over circuit relay.
          defaultDataLimit: BigInt(1 << 30), // 1 GB per circuit
          // Default duration limit is 2 minutes — too short for large transfers.
          // Set to 1 hour so long-running BitSwap sessions don't get cut off.
          defaultDurationLimit: 60 * 60 * 1000, // 1 hour in ms
        },
      }),
      dht: kadDHT({
        // Server mode - participates in DHT routing
        clientMode: false,
        kBucketSize: 20,
      }),
    },
  });

  await node.start();

  // ── GossipSub routing ─────────────────────────────────────────────────────
  // The relay participates in GossipSub so it can route messages between
  // browser peers that are only connected to the relay (not directly to each
  // other).  Without this, Browser A publishes → relay ignores it → Browser B
  // never receives it.

  const pubsub = node.services.pubsub;
  const NUM_SYNAPSES = 4;

  // Prototype-level fix applied at module load (see top of file).
  // AbstractMessageStream.prototype now has .source and .sink so it-pipe
  // treats every stream as a duplex and gossipsub outbound streams form correctly.

  for (const network of ['testnet', 'mainnet']) {
    for (let i = 0; i < NUM_SYNAPSES; i++) pubsub.subscribe(`neuronchain/${network}/blocks/${i}`);
    pubsub.subscribe(`neuronchain/${network}/votes`);
    pubsub.subscribe(`neuronchain/${network}/accounts`);
    pubsub.subscribe(`neuronchain/${network}/generation`);
    pubsub.subscribe(`neuronchain/${network}/storage/pin-requests`);
    pubsub.subscribe(`neuronchain/${network}/storage/receipts`);
    pubsub.subscribe(`neuronchain/${network}/lockouts`);
    pubsub.subscribe(`neuronchain/${network}/keyblobs`);
    pubsub.subscribe(`neuronchain/${network}/blob-requests`);
    pubsub.subscribe(`neuronchain/${network}/peer-addrs`);
  }

  // ── Peer-addr cache and replay ────────────────────────────────────────────
  // Problem: when Browser A publishes peer-addrs, Browser B may not be in the
  // relay's GossipSub mesh yet (mesh formation takes 1–3 gossipsub heartbeats).
  // Solution: the relay caches the latest peer-addrs per sender and replays
  // them to new subscribers + re-publishes after a short delay when received
  // so that peers who join the mesh slightly late still receive the addrs.

  // peerId → { topic, data: Uint8Array, timestamp: number }
  // Keyed by peerId (not topic:peerId) so we can filter by connection status.
  const peerAddrCache = new Map();
  // topic → setTimeout handle (debounce)
  const rebroadcastTimers = new Map();

  /** Return Set of peer ID strings currently connected to this relay. */
  function connectedPeerIds() {
    return new Set(node.getConnections().map(c => c.remotePeer.toString()));
  }

  /**
   * Re-broadcast all cached peer-addrs for `topic`, but ONLY for peers that are
   * currently connected to this relay. Stale entries from previous browser sessions
   * (which would cause NO_RESERVATION errors) are silently skipped.
   */
  function scheduleRebroadcast(topic, delayMs) {
    if (rebroadcastTimers.has(topic)) return;
    rebroadcastTimers.set(topic, setTimeout(() => {
      rebroadcastTimers.delete(topic);
      const connected = connectedPeerIds();
      const now = Date.now();
      let sent = 0;
      for (const [peerId, cached] of peerAddrCache) {
        if (cached.topic === topic &&
            now - cached.timestamp < 3 * 60 * 1000 && // 3-min TTL
            connected.has(peerId)) {
          pubsub.publish(topic, cached.data).catch(() => {});
          sent++;
        }
      }
      if (sent > 0) console.log(`[Relay] rebroadcast ${sent} live peer-addr(s) on ${topic}`);
    }, delayMs));
  }

  pubsub.addEventListener('message', (evt) => {
    const msg = evt.detail;
    if (!msg.topic.endsWith('/peer-addrs')) return;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(msg.data));
      if (decoded.peerId && Array.isArray(decoded.addrs) && decoded.addrs.length > 0) {
        peerAddrCache.set(decoded.peerId, {
          topic: msg.topic,
          data: msg.data,
          timestamp: Date.now(),
        });
        console.log(`[Relay] cached peer-addrs from ${decoded.peerId.slice(0,12)}: ${decoded.addrs.length} addr(s)`);
        // Re-broadcast after 1.5s so peers that joined the mesh slightly late
        // (GossipSub mesh formation takes up to ~2 heartbeats) still receive it.
        scheduleRebroadcast(msg.topic, 1500);
      }
    } catch { /* malformed - ignore */ }
  });

  // Dynamically mirror any neuronchain topic a browser peer subscribes to
  // (covers dynamic inbox topics like neuronchain/{network}/inbox/{pubShort}).
  // Also replays cached peer-addrs when a new peer subscribes to a peer-addrs topic.
  pubsub.addEventListener('subscription-change', (evt) => {
    for (const { topic, subscribe } of evt.detail.subscriptions) {
      if (subscribe && topic.startsWith('neuronchain/')) {
        try { pubsub.subscribe(topic); } catch { /* already subscribed */ }
      }
      if (subscribe && topic.endsWith('/peer-addrs')) {
        // New subscriber — replay cached peer-addrs (for currently-connected peers only)
        // after a delay so the GossipSub stream and mesh have time to fully form.
        setTimeout(() => {
          const connected = connectedPeerIds();
          const now = Date.now();
          let replayed = 0;
          for (const [peerId, cached] of peerAddrCache) {
            if (cached.topic === topic &&
                now - cached.timestamp < 3 * 60 * 1000 &&
                connected.has(peerId)) {
              pubsub.publish(topic, cached.data).catch(() => {});
              replayed++;
            }
          }
          if (replayed > 0) console.log(`[Relay] replayed ${replayed} live peer-addr(s) for new subscriber on ${topic}`);
          else console.log(`[Relay] no live peer-addr cache entries for ${topic} (${peerAddrCache.size} total, ${connected.size} connected)`);
        }, 2000);
      }
    }
  });

  const addrs = node.getMultiaddrs().map(a => a.toString());

  // ── HTTP /relay-info endpoint for Vite dev plugin ─────────────────────────

  const httpServer = createServer((req, res) => {
    if (req.url === '/relay-info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        peerId: node.peerId.toString(),
        multiaddrs: addrs,
        wsPort: PORT,
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(PORT + 2);

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  const shutdown = async () => {
    httpServer.close();
    await node.stop();
    process.exit(0);
  };

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  // Stats logging every 10s
  // setInterval(() => {
  //   const peers = node.getPeers().length;
  //   const conns = node.getConnections().length;
  //   const pubsubPeers = pubsub.getPeers().length;
  //   const subscribers = pubsub.getSubscribers('neuronchain/testnet/accounts');
  //   console.log(`[Relay] libp2p peers=${peers} conns=${conns} | gossipsub peers=${pubsubPeers} subscribers(accounts)=${subscribers.length}`);
  //   if (peers > 0) {
  //     const p = pubsub.peers ? [...pubsub.peers.keys()].map(id => id.slice(0,16)) : [];
  //     const out = pubsub.streamsOutbound ? [...pubsub.streamsOutbound.keys()].map(id => id.slice(0,16)) : [];
  //     const inp = pubsub.streamsInbound ? [...pubsub.streamsInbound.keys()].map(id => id.slice(0,16)) : [];
  //     console.log(`[Relay] gossip peers=${JSON.stringify(p)} outbound=${JSON.stringify(out)} inbound=${JSON.stringify(inp)}`);
  //     console.log(`[Relay] topics subscribed by peers:`, JSON.stringify([...( pubsub.topics?.entries?.() ?? [])]));
  //   }
  // }, 10_000);
}

main().catch(err => {
  console.error('[Relay] Fatal error:', err);
  process.exit(1);
});
