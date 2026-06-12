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
import { WebSocketServer } from 'ws';
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
// Comma-separated list of peer relay multiaddrs (must include /p2p/<peerId> suffix).
// Example: PEER_RELAYS=/dns4/relay2.example.com/tcp/9090/ws/p2p/<peerId2>
const PEER_RELAYS = (process.env.PEER_RELAYS || '').split(',').filter(Boolean);
const SIGNING_KEY_FILE = process.env.SIGNING_KEY_FILE || '.relay-signing-key.json';
const FACE_DB_FILE = process.env.FACE_DB_FILE || '.relay-face-db.json';

// Must match PROTOCOL_VERSION in src/network/libp2p-network.ts
const PROTOCOL_VERSION = 'v1';

// ── Face-verify session store ─────────────────────────────────────────────────
const CHALLENGE_TYPES = ['look-left', 'look-right', 'smile'];
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const IP_WINDOW_MS = 24 * 60 * 60 * 1000;
const IP_MAX_PER_DAY = 3;
/** Max accounts per face: testnet=3, mainnet=1 */
const FACE_MAX = { testnet: 3, mainnet: 1 };
/**
 * Euclidean distance threshold for "same face" — must match client MATCH_THRESHOLD.
 * Below this distance = same person; above = different person.
 */
const FACE_MATCH_THRESHOLD = 0.45;
/** challengeId → { type, createdAt, ip, used } */
const challengeSessions = new Map();
/** ip → { count, windowStart } */
const ipVerifyLog = new Map();
/**
 * Persistent face descriptor database.
 * Each entry: { descriptor: number[128], count: number, network: string }
 * Matching uses Euclidean distance < FACE_MATCH_THRESHOLD (same as client).
 * This is the only reliable Sybil check — hash-based counting fails because
 * face descriptors vary slightly between sessions and hash differently each time.
 */
let faceDescriptorDB = [];

async function loadFaceDB() {
  try {
    faceDescriptorDB = JSON.parse(await fs.readFile(FACE_DB_FILE, 'utf8'));
    console.log(`[FaceVerify] Loaded face DB: ${faceDescriptorDB.length} enrolled face(s)`);
  } catch { faceDescriptorDB = []; }
}

async function saveFaceDB() {
  await fs.writeFile(FACE_DB_FILE, JSON.stringify(faceDescriptorDB)).catch(() => {});
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < 128; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/**
 * Find the closest stored face entry for the given descriptor and network.
 * Returns the entry if within FACE_MATCH_THRESHOLD, otherwise null (= new face).
 */
function findMatchingFace(descriptor, network) {
  let best = null;
  let bestDist = Infinity;
  for (const entry of faceDescriptorDB) {
    if (entry.network !== network) continue;
    const d = euclideanDistance(descriptor, entry.descriptor);
    if (d < FACE_MATCH_THRESHOLD && d < bestDist) {
      bestDist = d;
      best = entry;
    }
  }
  return best;
}

// ── Face-verify helpers ───────────────────────────────────────────────────────

function getClientIp(req) {
  return ((req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0]).trim() || 'unknown';
}

function issueChallenge(ip) {
  const challengeId = globalThis.crypto.randomUUID();
  const type = CHALLENGE_TYPES[Math.floor(Math.random() * CHALLENGE_TYPES.length)];
  const now = Date.now();
  challengeSessions.set(challengeId, { type, createdAt: now, ip, used: false });
  // Prune expired entries periodically
  if (challengeSessions.size % 200 === 0) {
    for (const [id, s] of challengeSessions) {
      if (now - s.createdAt > CHALLENGE_TTL_MS) challengeSessions.delete(id);
    }
  }
  return { challengeId, type, expiresAt: now + CHALLENGE_TTL_MS };
}

function checkIpLimit(ip) {
  const now = Date.now();
  const entry = ipVerifyLog.get(ip);
  if (!entry || now - entry.windowStart > IP_WINDOW_MS) return true;
  return entry.count < IP_MAX_PER_DAY;
}

function recordIpVerification(ip) {
  const now = Date.now();
  const entry = ipVerifyLog.get(ip);
  if (!entry || now - entry.windowStart > IP_WINDOW_MS) {
    ipVerifyLog.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

function validateDescriptor(descriptor) {
  return Array.isArray(descriptor) &&
    descriptor.length === 128 &&
    descriptor.every(v => typeof v === 'number' && Number.isFinite(v) && v > -2.0 && v < 2.0);
}

async function computeFaceMapHash(descriptor) {
  // Must match face-verify.ts: quantize (QUANT_BIN=0.1) then hash
  const quantized = descriptor.map(v => Math.round(v / 0.1) * 0.1);
  const str = quantized.map(v => v.toFixed(4)).join(',');
  const encoded = new TextEncoder().encode(str);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loadOrCreateSigningKey() {
  try {
    const saved = JSON.parse(await fs.readFile(SIGNING_KEY_FILE, 'utf8'));
    const privKey = await globalThis.crypto.subtle.importKey(
      'jwk', saved.private, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
    );
    const pubKeyStr = Buffer.from(JSON.stringify(saved.public)).toString('base64');
    console.log('[FaceVerify] Loaded existing signing key');
    return { privKey, pubKeyStr };
  } catch {
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    );
    const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
    const publicJwk  = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
    await fs.writeFile(SIGNING_KEY_FILE, JSON.stringify({ private: privateJwk, public: publicJwk }));
    console.log('[FaceVerify] Generated new signing key pair');
    return { privKey: pair.privateKey, pubKeyStr: Buffer.from(JSON.stringify(publicJwk)).toString('base64') };
  }
}

async function signFaceMapHash(faceMapHash, privKey) {
  const encoded = new TextEncoder().encode(faceMapHash);
  const sigBytes = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, encoded);
  const b64sig = Buffer.from(sigBytes).toString('base64');
  return JSON.stringify({ d: faceMapHash, s: b64sig });
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 65536) reject(new Error('Request too large'));
    });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

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
  const signingKey = await loadOrCreateSigningKey();
  await loadFaceDB();

  // relayAddrs is populated after node.start(); empty until then (relay-info returns [] multiaddrs)
  let relayAddrs = [];

  // ── HTTP server (started BEFORE libp2p so face-verify works even if ports conflict) ──

  const httpServer = createServer(async (req, res) => {
    // CORS preflight for face-verify endpoints
    if (req.url?.startsWith('/face-verify')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }

    try {
      if (req.url === '/relay-info') {
        // Always 200 so the HTTP face-verify fallback (which only needs signingPub) works
        // even before — or without — libp2p. `ready` reports whether the p2p layer is
        // dialable yet (relayAddrs populated after node.start()); p2p clients retry while
        // it's false instead of caching an empty multiaddr list, and monitoring can use it
        // to detect a relay whose p2p layer never came up.
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          ready: relayAddrs.length > 0,
          peerId: peerId.toString(),
          multiaddrs: relayAddrs,
          wsPort: PORT,
          signingPub: signingKey.pubKeyStr,
          faceVerifyUrl: '',
        }));

      } else if (req.method === 'POST' && req.url === '/log-reload') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          const line = `[${new Date().toISOString()}] ${body.trim()}\n`;
          await fs.appendFile('reload.log', line).catch(() => {});
          res.writeHead(204);
          res.end();
        });

      } else if (req.method === 'POST' && req.url === '/face-verify/challenge') {
        const ip = getClientIp(req);
        if (!checkIpLimit(ip)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Rate limit: max 3 verifications per IP per 24h' }));
          return;
        }
        const challenge = issueChallenge(ip);
        console.log(`[FaceVerify] Challenge issued: type=${challenge.type} ip=${ip}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(challenge));

      } else if (req.method === 'POST' && req.url === '/face-verify/verify') {
        const ip = getClientIp(req);
        let body;
        try { body = await readJsonBody(req); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message })); return;
        }
        const { descriptor, faceMapHash, challengeId } = body;

        // Derive the Map key once and use it for every lookup/delete so they can't diverge
        // (set/get/delete must agree, else a used or expired session leaks and survives).
        const sessionKey = String(challengeId || '');
        const session = challengeSessions.get(sessionKey);
        if (!session) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired challengeId' })); return;
        }
        if (session.used) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'challengeId already used' })); return;
        }
        if (Date.now() - session.createdAt > CHALLENGE_TTL_MS) {
          challengeSessions.delete(sessionKey);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Challenge expired' })); return;
        }
        if (!validateDescriptor(descriptor)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'descriptor must be 128 finite numbers in (-2, 2)' })); return;
        }
        const expectedHash = await computeFaceMapHash(descriptor);
        if (expectedHash !== String(faceMapHash || '')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'faceMapHash does not match descriptor' })); return;
        }
        if (!checkIpLimit(ip)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' })); return;
        }
        const network = req.headers['x-network'] === 'mainnet' ? 'mainnet' : 'testnet';
        const faceMax = FACE_MAX[network];

        // Fuzzy face match: find the closest stored descriptor within FACE_MATCH_THRESHOLD.
        // Hash-based counting is unreliable because face descriptors shift between sessions
        // (lighting, angle) causing quantization bin flips and different hashes for the same face.
        const matchedFace = findMatchingFace(descriptor, network);
        const faceCount = matchedFace ? matchedFace.count : 0;
        if (faceCount >= faceMax) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Face limit reached (${faceCount}/${faceMax} on ${network})` })); return;
        }

        session.used = true;
        recordIpVerification(ip);

        if (matchedFace) {
          matchedFace.count++;
          // Update centroid so future sessions are compared against a current reference,
          // preventing descriptor drift from creating a false "new face" entry.
          for (let i = 0; i < 128; i++) {
            matchedFace.descriptor[i] = (matchedFace.descriptor[i] + descriptor[i]) / 2;
          }
        } else {
          faceDescriptorDB.push({ descriptor: Array.from(descriptor), count: 1, network });
        }
        await saveFaceDB();

        const sig = await signFaceMapHash(faceMapHash, signingKey.privKey);
        console.log(`[FaceVerify] Signed for ip=${ip} face=${faceCount + 1}/${faceMax} (${matchedFace ? `matched dist<${FACE_MATCH_THRESHOLD}` : 'new face'})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sig, signingPub: signingKey.pubKeyStr }));

      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (e) {
      console.error('[FaceVerify] HTTP error:', e);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
  });

  // ── Smoke Hub ──────────────────────────────────────────────────────────────
  const smokeHubWss = new WebSocketServer({ noServer: true });
  const smokeHubPeers = new Map();

  smokeHubWss.on('connection', (ws) => {
    let address = null;
    const keepAlive = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 15_000);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!address && msg.type === 'register' && typeof msg.address === 'string') {
          address = msg.address;
          smokeHubPeers.set(address, ws);
          console.log(`[SmokeHub] Peer registered: ${address.slice(0, 8)}...`);
          return;
        }
        if (address && typeof msg.to === 'string' && smokeHubPeers.has(msg.to)) {
          const target = smokeHubPeers.get(msg.to);
          if (target.readyState === 1) target.send(JSON.stringify({ ...msg, from: address }));
        }
      } catch { /* ignore malformed */ }
    });
    ws.on('close', () => {
      clearInterval(keepAlive);
      if (address) { smokeHubPeers.delete(address); console.log(`[SmokeHub] Peer disconnected: ${address.slice(0, 8)}...`); address = null; }
    });
  });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/smoke-hub') {
      smokeHubWss.handleUpgrade(req, socket, head, (ws) => { smokeHubWss.emit('connection', ws, req); });
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(PORT + 2, () => console.log(`[Relay] HTTP/face-verify server listening on port ${PORT + 2}`));

  // ── Start libp2p node ────────────────────────────────────────────────────────
  // Wrapped in try/catch: if libp2p fails (e.g. EADDRINUSE) the HTTP face-verify
  // server stays alive so clients can still get relay credentials.

  let node;
  try {
    node = await createLibp2p({
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
            // Default data limit is 128 KB per circuit - raise it so large content
            // transfers (signaling, libp2p protocol messages) can complete freely.
            defaultDataLimit: BigInt(1 << 30), // 1 GB per circuit
            // Default duration limit is 2 minutes - raise it for long-running sessions.
            // Set to 1 hour so smoke WebRTC sessions don't get cut off mid-transfer.
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
  } catch (e) {
    console.error('[Relay] libp2p failed to start — HTTP/face-verify server remains available:', e.message);
    return; // main() resolves normally; httpServer keeps the process alive
  }

  // ── Server-side keepalive pings ───────────────────────────────────────────
  // Ping all connected peers every 10s so the WebSocket TCP connections stay
  // alive through NAT. Both sides must push bytes — the browser pings the relay
  // and the relay pings the browser. Without server-side pings, an idle browser
  // tab that sends no libp2p traffic loses its NAT mapping anyway.
  const pingService = node.services.ping;
  if (pingService) {
    setInterval(() => {
      for (const conn of node.getConnections()) {
        try { pingService.ping(conn.remotePeer).catch(() => {}); } catch { /* conn closed mid-loop */ }
      }
    }, 10_000);
  }

  // ── Relay-to-relay mesh ───────────────────────────────────────────────────
  // Dial each peer relay from PEER_RELAYS so their GossipSub meshes merge.
  // Without this, browsers on relay-A and browsers on relay-B are in separate
  // GossipSub islands and cannot see each other's messages.
  if (PEER_RELAYS.length > 0) {
    const { multiaddr } = await import('@multiformats/multiaddr');

    async function dialPeerRelays() {
      const connected = new Set(node.getConnections().map(c => c.remotePeer.toString()));
      for (const addr of PEER_RELAYS) {
        // Extract peer ID from the /p2p/<id> suffix to check active connections
        const peerIdMatch = addr.match(/\/p2p\/([^/]+)$/);
        const peerId = peerIdMatch?.[1];
        if (peerId && connected.has(peerId)) continue;
        try {
          await node.dial(multiaddr(addr));
          console.log(`[Relay] Connected to peer relay: ${addr}`);
        } catch (e) {
          console.warn(`[Relay] Could not reach peer relay ${addr}: ${e.message}`);
        }
      }
    }

    await dialPeerRelays();
    // Reconnect loop: re-dial dropped peer relays every 60s
    setInterval(dialPeerRelays, 60_000);
  }

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
    const pfx = `neuronchain/${PROTOCOL_VERSION}/${network}`;
    for (let i = 0; i < NUM_SYNAPSES; i++) pubsub.subscribe(`${pfx}/blocks/${i}`);
    pubsub.subscribe(`${pfx}/votes`);
    pubsub.subscribe(`${pfx}/accounts`);
    pubsub.subscribe(`${pfx}/generation`);
    pubsub.subscribe(`${pfx}/storage/cache-requests`);
    pubsub.subscribe(`${pfx}/storage/receipts`);
    pubsub.subscribe(`${pfx}/storage/delete-requests`);
    pubsub.subscribe(`${pfx}/lockouts`);
    pubsub.subscribe(`${pfx}/keyblobs`);
    pubsub.subscribe(`${pfx}/blob-requests`);
    pubsub.subscribe(`${pfx}/peer-addrs`);
    pubsub.subscribe(`${pfx}/relays`);
    pubsub.subscribe(`${pfx}/snapshots`);
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
        // Re-broadcast after 1.5s so peers that joined the mesh slightly late
        // (GossipSub mesh formation takes up to ~2 heartbeats) still receive it.
        scheduleRebroadcast(msg.topic, 1500);
      }
    } catch { /* malformed - ignore */ }
  });

  // Dynamically mirror any neuronchain topic a browser peer subscribes to
  // (covers dynamic inbox topics like neuronchain/v1/{network}/inbox/{pubShort}).
  // Also replays cached peer-addrs when a new peer subscribes to a peer-addrs topic.
  pubsub.addEventListener('subscription-change', (evt) => {
    for (const { topic, subscribe } of evt.detail.subscriptions) {
      if (subscribe && topic.startsWith(`neuronchain/${PROTOCOL_VERSION}/`)) {
        try { pubsub.subscribe(topic); } catch { /* already subscribed */ }
      }
      if (subscribe && topic.endsWith('/peer-addrs')) {
        // New subscriber - replay cached peer-addrs (for currently-connected peers only)
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
        }, 2000);
      }
    }
  });

  // Populate relay addresses now that node is up
  relayAddrs = node.getMultiaddrs().map(a => a.toString());

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  const shutdown = async () => {
    httpServer.close();
    await node.stop();
    process.exit(0);
  };

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[Relay] Unhandled error in main():', err);
  // Do NOT process.exit — the HTTP face-verify server may still be alive and serving clients.
});
