# NeuronChain

A browser-based blockchain using a **block-lattice DAG** with **stake-weighted voting** and **face-locked keys**. Powered by **libp2p** (WebRTC + GossipSub + Kademlia DHT) and **Helia/IPFS** for decentralised content storage — no central relay on the data path.

## Currency: Neuron Unit (UNIT)

- **1,000,000 UNIT** minted per account upon creation (FaceID mandatory)
- **3 decimal precision** (milli-UNIT) — smallest transferable unit is 0.001 UNIT
- All operations are **zero fee**
- Inflationary: total supply grows with each new account (limited to total number of humans)
- **Mainnet:** 1 account per face (1 human = 1 account)
- **Testnet:** up to 3 accounts per face (for testing)

## Quick Start

```bash
npm install
npm run dev        # Starts Vite + libp2p relay on port 9090
npm run tunnel     # (second terminal) HTTPS tunnel for multiple-device testing
```

**For mobile / multi-device:** open the tunnel URL on your phone.

### First Steps

1. **Create account** — Account tab → choose username → face scan → 1,000,000 UNIT minted
2. **Start node** — Node tab → Start Node (connects to relay, starts syncing via libp2p + Helia)
3. **Send UNIT** — Transfer tab → recipient username → amount
4. **Claim receives** — Transfer tab → Pending Receives → Claim
5. **Recover account** — Account tab → enter username → face scan (from any device)
6. **Store content** — Storage tab → select account → paste JSON or upload file → get CID
7. **Deploy contract** — Contracts tab → load Token or NFT template → deploy

### Production Relay

Run the relay server independently (separate from the app):

```bash
node relay-server.js       # Defaults to port 9090
PORT=443 node relay-server.js   # Or any port
```

The relay serves three roles:
- **GossipSub router** — subscribes to all `neuronchain/*` topics and routes messages between browser peers (required while browsers remain on circuit-relay connections; once browsers upgrade to direct WebRTC the relay is off the data path)
- **Circuit relay v2** — NAT traversal: relays connections when direct WebRTC fails
- **Bootstrap / DHT server** — provides initial peer addresses and Kademlia routing

## Architecture

### Block-Lattice DAG

Each account has its own chain of blocks. Transfers require two blocks:
- **Send block** on the sender's chain (deducts balance)
- **Receive block** on the recipient's chain (credits balance)

Uncontested blocks are confirmed immediately (**optimistic confirmation**). When two blocks reference the same parent (fork), **conflict-only stake-weighted voting** kicks in:

1. Network detects conflict
2. Nodes broadcast votes (ECDSA-signed, include `chainHeadHash` balance proof)
3. Ledger verifies vote stake against local chain state
4. First side to reach >2/3 of total stake wins (10s timeout)
5. Rejected chain rolled back, unclaimed sends restored

### P2P Networking (libp2p)

| Layer | Technology | Role |
|---|---|---|
| Transport | WebRTC | Browser-to-browser direct connections |
| Transport | WebSockets | Browser-to-relay (bootstrap only) |
| NAT traversal | Circuit Relay v2 | Relayed connection when WebRTC fails |
| Peer discovery | Kademlia DHT | Decentralised — no central peer registry |
| Pubsub | GossipSub | Blocks, votes, accounts, inbox signals |
| Persistence | IndexedDB | Full chain stored locally — no relay dependency |
| Content | Helia/Bitswap | Large content — parallel chunk transfer |

**Bootstrap address** (dev): `ws://localhost:9090`  
**Custom bootstrap**: `localStorage.setItem('neuronchain_bootstrap', JSON.stringify(['/dns4/relay.example.com/tcp/9090/ws/p2p/<peerID>']))`

GossipSub topics are sharded across 4 synapse paths by `hash(accountPub) % 4`.

### Content Storage

NeuronChain is a full content network — posts, images, video, audio, HTML, CSS, JS, and JSON are stored **on NeuronChain** using its decentralised Helia/IPFS layer. Each piece of content is:

- **Content-addressed** by SHA-256 CID — tamper-evident: any peer serving a wrong byte is rejected
- **Anchored on-chain** — the CID is recorded in `block.contentCid` or smart contract state, creating an immutable provenance proof
- **ECDSA-signed** — every store action is signed by the account key regardless of visibility
- **Served by any peer** that holds a copy via Bitswap (parallel chunk transfer, BitTorrent-style)
- **Persisted locally** in IndexedDB — readable offline without a relay

Content has **dynamic visibility**:

| Visibility | Storage | Who can read |
|---|---|---|
| **Public** | Raw bytes, no encryption | Anyone with the CID |
| **Private** | AES-256-GCM encrypted with the account's content key | Only the key holder |

Retrieval auto-detects visibility: tries decryption first, falls back to public read.

### Decentralised Storage Ledger

NeuronChain has a built-in automated storage incentive system — no marketplace, no manual deals:

| Step | Action | On-chain |
|---|---|---|
| Provider registers | `storage-register` block (capacityGB) | Yes |
| Proof of uptime | `storage-heartbeat` block every ~4h | Yes |
| Daily reward | `storage-reward` block — mints new UNIT | Yes |
| Content distribution | Pin request via GossipSub → Helia/Bitswap | Off-chain |
| Off-chain metrics | Retrieval receipts (latency, spot-check) | Off-chain |

**Earning rate formula:**
```
daily_rate = 1 UNIT × capacityGB × uptime_factor × latency_factor × spot_check_factor

uptime_factor    = heartbeat_blocks_today / 6       (max 1.0)
latency_factor   = 1000ms / avg_retrieval_latency   (max 1.0)
spot_check_factor = checks_passed / checks_received (max 1.0)
```

Rewards are self-issued daily via a `storage-reward` block. Other nodes verify the amount against the on-chain heartbeat count before accepting. Over-claiming is rejected by the ledger.

**Content distribution:** uploaders select up to 10 providers via weighted-random (weight = capacityGB × score), publish a signed pin request, and providers fetch via Helia/Bitswap. Providers re-pin on startup from their local blockstore.

**Sybil resistance:** face-lock enforces 1 account per face on mainnet → 1 storage provider registration per person.

### Smart Contracts

JavaScript contracts execute in an isolated **Web Worker sandbox**:

- No access to DOM, `fetch`, `localStorage`, `WebSocket`, or any browser API
- Execution timeout: 3 seconds
- Contract calls on conflicted blocks are deferred until conflict resolved
- Contract state is persistent across calls

**Built-in examples** (load from Contracts tab):

**Simple Token (ERC-20 style)**
```javascript
function init(name, symbol, totalSupply) { ... }
function transfer(to, amount) { ... }
function balanceOf(address) { ... }
```

**NFT Collection (ERC-721 style)**
```javascript
function init(name, symbol) { ... }
function mint(metadata, cid) { ... }   // cid = Helia CID of media content
function transfer(tokenId, to) { ... }
function ownerOf(tokenId) { ... }
function myTokens() { ... }
```

NFT media is stored in Helia — the CID passed to `mint()` is a content pointer to the encrypted image/video/audio.

### dApp API

Build applications on NeuronChain using the `NeuronChainAPI` facade in [`src/api/neuronchain-api.ts`](src/api/neuronchain-api.ts).

See **[CONTENT_API.md](CONTENT_API.md)** for the full API reference including content types, schemas, events, and code examples.

### Face-Locked Keys

- **Liveness check** (head movement detection, 15s timeout)
- **Face enrollment** — 3 captures averaged into a 128-dim descriptor
- **Quantization** — stable bins so the same face produces the same key across sessions
- **Key derivation** — PBKDF2 (100K iterations) → AES-256-GCM
- **Encryption** — ECDSA key pair encrypted with face-derived key
- **On-chain storage** — encrypted blob stored on libp2p network + local IndexedDB
- **Key blob integrity** — SHA-256 hash of blob stored on-chain; verified on recovery
- **Backup** — JSON key pair shown once at creation

### Security

| Layer | Protection |
|---|---|
| Transport | Noise protocol (libp2p) — all peer connections encrypted + authenticated |
| Blocks | ECDSA P-256 signatures on every block |
| Accounts | ECDSA-signed account data — peers reject unsigned accounts |
| Votes | ECDSA-signed votes + balance proofs (`chainHeadHash`) |
| Inbox signals | ECDSA-signed by sender — recipients verify before accepting |
| Key blobs | SHA-256 content hash stored on-chain — tamper detection on recovery |
| Smart contracts | Web Worker sandbox — no DOM/network/storage access |
| Content | AES-256-GCM encryption before IPFS storage |
| Generation governance | Mainnet resets require signed message from known operator keys |
| Null-write rejection | Client-side null-field guards on all received data |
| Balance overflow | `Number.isSafeInteger` validation on all amounts |
| Peer gossip | GossipSub message signing — rogue peers can't inject unsigned messages |

## Technical Specs

| Spec | Value |
|---|---|
| Key pairs | ECDSA P-256 + ECDH P-256 (Web Crypto API — zero external dependency) |
| Block hashing | SHA-256 (Web Crypto API) |
| Content encryption | AES-256-GCM, key via PBKDF2 from ECDH private key |
| Face key derivation | PBKDF2 (100K iterations) → AES-256-GCM |
| Face descriptor | 128 dimensions, quantized to 0.05 bins |
| Consensus | Optimistic confirmation + conflict-only stake-weighted voting (>2/3, 10s timeout) |
| P2P | libp2p — WebRTC, WebSockets, circuit relay v2, GossipSub, Kademlia DHT |
| Content storage | Helia/IPFS with Bitswap — content-addressed, encrypted, parallel chunks |
| Local persistence | IndexedDB — blocks, accounts, keyblobs, contracts survive relay downtime |
| Max safe balance | `Number.MAX_SAFE_INTEGER` (milli-UNIT) |
| Smart contract timeout | 3 seconds |
| Storage payment interval | 24 hours (configurable) |

## File Structure

```
neuronchain/
├── src/
│   ├── api/
│   │   └── neuronchain-api.ts    # dApp API facade
│   ├── core/
│   │   ├── crypto.ts             # Web Crypto API — ECDSA/ECDH/AES
│   │   ├── dag-block.ts          # Block types + hashing + validation
│   │   ├── dag-ledger.ts         # Block-lattice state machine + storage deals
│   │   ├── vote.ts               # Stake-weighted voting + balance proofs
│   │   ├── account.ts            # Account model
│   │   ├── face-verify.ts        # FaceID liveness + enrollment
│   │   ├── face-store.ts         # Face-locked key encryption/decryption
│   │   └── events.ts             # EventEmitter
│   └── network/
│       ├── libp2p-network.ts     # libp2p + GossipSub + IndexedDB
│       ├── helia-store.ts        # Helia/IPFS content storage
│       ├── storage-manager.ts    # Storage deal lifecycle + 24h payments
│       └── node.ts               # NeuronNode — orchestrates all layers
├── relay-server.js               # libp2p relay + circuit relay v2 (Node.js)
├── vite-libp2p-plugin.ts         # Vite plugin: spawns relay in dev
├── vite.config.ts
├── index.html                    # Browser UI
└── package.json
```

## Remaining Architectural Notes

- **Bootstrap dependency**: libp2p still needs bootstrap nodes to find initial peers. Run multiple community bootstrap/relay nodes for mainnet.
- **Relay on gossipsub path**: while browser-to-browser connections run over circuit relay (before WebRTC upgrade), the relay node must also participate in GossipSub to route messages between those peers. Once peers upgrade to direct WebRTC, the relay is off the data path. For true relay-independence, run multiple independent community relays.
- **Auto-receive timing window**: `autoReceive` fires when the recipient's node receives the SEND block via GossipSub. If the recipient was briefly disconnected, they can claim the pending receive manually (Transfer → Pending Receives). The sender re-broadcasts every 20s so auto-receive will eventually fire.
- **Waku alternative**: Waku (built on libp2p) provides a ready bootstrap fleet and built-in message store, but has a 150KB message size limit that prevents direct content storage. libp2p + Helia is the correct choice when storing arbitrary content.
- **Face uniqueness**: enforced locally via Euclidean distance on 128-dim descriptors. A global uniqueness proof (ZK biometrics) is an open research problem.
- **BFT finality**: optimistic confirmation with conflict voting is not BFT. Under a 33%+ Sybil attack, forks can persist. Full BFT (e.g., HotStuff) is a future upgrade path.

## GossipSub Compatibility Patches

libp2p and gossipsub ship as separate packages and their internal APIs drifted across minor versions. Three prototype-level patches are applied at startup (in both `relay-server.js` and `src/network/libp2p-network.ts`) to bridge the mismatches in the currently pinned versions:

**Fix A — `AbstractMessageStream` missing `.sink` / `.source`**  
New libp2p streams expose `Symbol.asyncIterator` + `send()` but not the `.sink` / `.source` duplex interface that `it-pipe` requires (`isDuplex(s) = s.sink != null && s.source != null`). Without this, gossipsub's `OutboundStream` constructor throws synchronously inside `createOutboundStream`, is silently caught, and `streamsOutbound` is never populated — no messages flow. Fixed by `Object.defineProperty(AbstractMessageStream.prototype, 'source/sink', ...)`.

**Fix B — `multiaddr.tuples()` API mismatch in `GossipSub.addPeer`**  
Gossipsub 14.x calls `multiaddr.tuples()` on peer addresses for IP scoring. When two different installations of `@multiformats/multiaddr` are resolved by Node (the common split-package scenario), libp2p's internal Multiaddr instances lack `.tuples()`, causing `addPeer()` to throw *before* `outboundInflightQueue.push()` — peers are never queued for stream creation. Fixed by wrapping `addPeer` in try/catch and manually inserting the peer into `this.peers`, `this.score`, and `this.outbound`.

**Fix C — `onIncomingStream` handler signature mismatch**  
This version of libp2p calls registered protocol handlers as `handler(stream, connection)` (two positional args). Gossipsub 14.x expects `handler({ stream, connection })` (one destructured object). The mismatch means `connection` is always `undefined` inside gossipsub, `createInboundStream` is never called, `streamsInbound` stays empty, subscriptions are never exchanged, the mesh never forms, and messages are never delivered. Fixed by patching `onIncomingStream` to detect the two-arg calling convention and wrap into the expected object form.
