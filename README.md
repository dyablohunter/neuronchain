# NeuronChain

A browser-based blockchain using a **block-lattice DAG** with **stake-weighted voting** and **two-factor face + PIN locked keys**. Powered by **libp2p** (WebRTC + GossipSub + Kademlia DHT) and **@sinclair/smoke** (HTTP-over-WebRTC + IndexedDB) for decentralised content storage - no central relay on the data path.

## Currency: Neuron Unit (UNIT)

- **1,000,000 UNIT** minted per account upon creation (FaceID mandatory)
- **3 decimal precision** (milli-UNIT) - smallest transferable unit is 0.001 UNIT
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

1. **Create account** - Account tab → choose username → liveness check → face enrollment (3 captures) → set 4-digit PIN → 1,000,000 UNIT minted → save backup secret key
2. **Start node** - Node tab → Start Node (connects to relay, starts syncing via libp2p + smoke)
3. **Send UNIT** - Transfer tab → recipient username → amount → **PIN required**
4. **Recover account** - Account tab → enter username → PIN prompt → face scan / paste backup secret key (from any device)
5. **Store content** - Storage tab → select account → paste JSON or upload file → get CID
6. **Deploy contract** - Contracts tab → load Token or NFT template → deploy → **PIN required**
7. **Update PIN / face** - Account tab → Update PIN / Face section → authenticate → change credentials

### Production Relay

Run the relay server independently (separate from the app):

```bash
node relay-server.js       # Defaults to port 9090
PORT=443 node relay-server.js   # Or any port
```

The relay serves four roles:
- **GossipSub router** - subscribes to all `neuronchain/v1/*` topics and routes messages between browser peers (required while browsers remain on circuit-relay connections; once browsers upgrade to direct WebRTC the relay is off the data path)
- **Circuit relay v2** - NAT traversal: relays connections when direct WebRTC fails
- **Bootstrap / DHT server** - provides initial peer addresses and Kademlia routing
- **Smoke hub** (`/smoke-hub` on port 9092) - WebSocket signaling for smoke's HTTP-over-WebRTC block transfer layer

### Running Multiple Relays

Multiple relays on separate servers form a mesh so that browsers connected to different relays can still reach each other. Each relay dials the others at startup and maintains the connections with a 60-second reconnect loop.

**Step 1 — start each relay and get its peer ID:**

```bash
# On server A
node relay-server.js
# On server B
node relay-server.js
```

Each relay prints its peer ID on first start and persists it to `.relay-peer-id.json`. You can also fetch it at any time:

```bash
curl http://<server-A>:9092/relay-info
# {"peerId":"12D3KooWAbc...","multiaddrs":[...],"wsPort":9090}
```

**Step 2 — restart each relay pointing at the others:**

```bash
# On server A — knows about B and C
PEER_RELAYS=/dns4/relay-b.example.com/tcp/9090/ws/p2p/12D3KooWBbb...,/dns4/relay-c.example.com/tcp/9090/ws/p2p/12D3KooWCcc... \
  node relay-server.js

# On server B — knows about A and C
PEER_RELAYS=/dns4/relay-a.example.com/tcp/9090/ws/p2p/12D3KooWAaa...,/dns4/relay-c.example.com/tcp/9090/ws/p2p/12D3KooWCcc... \
  node relay-server.js
```

Each entry in `PEER_RELAYS` must include the `/p2p/<peerId>` suffix — libp2p uses it to authenticate the Noise handshake and will refuse to connect without it. The peer ID is stable across restarts as long as `.relay-peer-id.json` is preserved.

**Step 3 — bake the bootstrap list into the app build:**

Browsers auto-detect the relay they are served from via `/relay-info`. To additionally point them at the full relay set, set `BOOTSTRAP_ADDRS` at build time:

```bash
BOOTSTRAP_ADDRS="/dns4/relay-a.example.com/tcp/443/wss/http-path/relay-ws/p2p/12D3KooWAaa...,/dns4/relay-b.example.com/tcp/443/wss/http-path/relay-ws/p2p/12D3KooWBbb..." \
  npm run build
```

Users can also override the bootstrap list at runtime without a rebuild:

```js
localStorage.setItem('neuronchain_bootstrap', JSON.stringify([
  '/dns4/relay-a.example.com/tcp/443/wss/http-path/relay-ws/p2p/12D3KooWAaa...',
  '/dns4/relay-b.example.com/tcp/443/wss/http-path/relay-ws/p2p/12D3KooWBbb...',
]));
```

**Systemd example (server A):**

```ini
[Service]
ExecStart=node /opt/neuronchain/relay-server.js
Environment=PORT=9090
Environment=PEER_ID_FILE=/var/lib/neuronchain/.relay-peer-id.json
Environment=PEER_RELAYS=/dns4/relay-b.example.com/tcp/9090/ws/p2p/12D3KooWBbb...,/dns4/relay-c.example.com/tcp/9090/ws/p2p/12D3KooWCcc...
Restart=always
```

**Docker Compose example:**

```yaml
services:
  relay-a:
    image: node:22
    working_dir: /app
    volumes:
      - ./:/app
      - relay-a-data:/data
    command: node relay-server.js
    environment:
      PORT: "9090"
      PEER_ID_FILE: /data/.relay-peer-id.json
      PEER_RELAYS: "/dns4/relay-b.example.com/tcp/9090/ws/p2p/12D3KooWBbb..."
    ports:
      - "9090:9090"
      - "9092:9092"

volumes:
  relay-a-data:
```

**Protocol version isolation:**

GossipSub topics are namespaced as `neuronchain/v1/<network>/...`. Nodes running a different protocol version (e.g. a fork) will use different topic strings and will not interact with the main network even if they connect to the same relay. When the wire format changes in a future release, bump `PROTOCOL_VERSION` in `src/network/libp2p-network.ts` and `relay-server.js` together.

**Relay multiaddr format:**

Every relay address used in `PEER_RELAYS`, `BOOTSTRAP_ADDRS`, or `localStorage` is a [multiaddr](https://multiformats.io/multiaddr/) — a self-describing, protocol-layered address string:

```
/dns4/relay.example.com/tcp/443/wss/http-path/relay-ws/p2p/12D3KooW...
```

| Segment | Meaning |
|---|---|
| `/dns4/relay.example.com` | IPv4 DNS hostname |
| `/tcp/443` | TCP port |
| `/wss` | WebSocket Secure (TLS) |
| `/http-path/relay-ws` | HTTP upgrade path — must match the server's `WS_PATH` (`/relay-ws` by default) |
| `/p2p/12D3KooW...` | The relay's libp2p peer ID — required for identity verification |

Common variants:

```
# Cleartext WebSocket (dev / local)
/ip4/127.0.0.1/tcp/9000/ws/p2p/12D3KooW...

# DNS + plain WS (behind a TLS-terminating proxy)
/dns4/relay.example.com/tcp/80/ws/http-path/relay-ws/p2p/12D3KooW...

# IPv6
/dns6/relay.example.com/tcp/443/wss/http-path/relay-ws/p2p/12D3KooW...
```

The peer ID (`12D3KooW...`) is derived from the relay's keypair and is printed to the console on first start. It is also available via `curl http://<server>:9092/relay-info`.

## Architecture

### Block-Lattice DAG

Each account has its own chain of blocks. Transfers require two blocks:
- **Send block** on the sender's chain (deducts balance)
- **Receive block** on the recipient's chain (credits balance)

Uncontested blocks are confirmed immediately (**optimistic confirmation**). When two blocks reference the same parent (fork), **conflict-only stake-weighted voting** kicks in:

1. Network detects conflict
2. Nodes broadcast ECDSA-signed votes including `chainHeadHash` as a balance proof
3. Ledger verifies vote stake against local chain state
4. **Tie-break policy**: the block with the earliest timestamp wins; hash lexicographic order breaks exact ties - deterministic, removes first-mover advantage
5. Nodes that have not yet loaded the conflicting block's parent chain send a signed **abstain** vote - counted for participation but excluded from the ≥2/3 threshold, so uninformed nodes cannot bias the outcome
6. First side to reach >2/3 of non-abstain stake wins (10s timeout falls back to timestamp winner)
7. Rejected chain rolled back, unclaimed sends restored

### P2P Networking (libp2p)

| Layer | Technology | Role |
|---|---|---|
| Transport | WebRTC | Browser-to-browser direct connections |
| Transport | WebSockets | Browser-to-relay (bootstrap only) |
| NAT traversal | Circuit Relay v2 | Relayed connection when WebRTC fails |
| Peer discovery | Kademlia DHT | Decentralised - no central peer registry |
| Pubsub | GossipSub | Blocks, votes, accounts, inbox signals |
| Persistence | IndexedDB | Full chain stored locally - no relay dependency |
| Content | smoke FileSystem + Http | Large content - HTTP-over-WebRTC transfer |

**Bootstrap address** (dev): `ws://localhost:9090`  
**Custom bootstrap**: `localStorage.setItem('neuronchain_bootstrap', JSON.stringify(['/dns4/relay.example.com/tcp/9090/ws/p2p/<peerID>']))`

GossipSub topics are sharded across 4 synapse paths by `hash(accountPub) % 4`.

### Content Storage

NeuronChain is a full content network - posts, images, video, audio, HTML, CSS, JS, and JSON are stored **on NeuronChain** using its own content layer. `@sinclair/smoke` provides IndexedDB-backed local storage and HTTP-over-WebRTC for peer-to-peer block transfer - content is served by NeuronChain peers directly, with no dependency on the public IPFS network. Each piece of content is:

- **Content-addressed** by SHA-256 CID (`bafkrei…` format via `multiformats`) - tamper-evident: any peer serving a wrong byte is rejected
- **Anchored on-chain** - the CID is recorded in `block.contentCid` or smart contract state, creating an immutable provenance proof
- **ECDSA-signed** - every store action is signed by the account key regardless of visibility
- **Served by any peer** that holds a copy via smoke Http (HTTP-over-WebRTC to the peer's virtual port 5891)
- **Persisted locally** in IndexedDB - readable offline without a relay

Content has **dynamic visibility**:

| Visibility | Storage | Who can read |
|---|---|---|
| **Public** | Raw bytes, no encryption | Anyone with the CID |
| **Private** | AES-256-GCM encrypted with the account's content key | Only the key holder |

Retrieval auto-detects visibility: tries decryption first, falls back to public read.

### Decentralised Storage Ledger

NeuronChain has a built-in automated storage incentive system - no marketplace, no manual deals:

| Step | Action | On-chain |
|---|---|---|
| Provider registers | `storage-register` block (capacityGB) | Yes |
| Proof of uptime | `storage-heartbeat` block every ~4h | Yes |
| Daily reward | `storage-reward` block - mints new UNIT | Yes |
| Content distribution | Cache request via GossipSub → smoke Http fetch | Off-chain |
| Content deletion | Delete request via GossipSub → all holders drop blocks | Off-chain |
| Off-chain metrics | Retrieval receipts (latency, spot-check) | Off-chain |

**Earning rate formula:**
```
daily_rate = 1 UNIT × min(actualStoredGB, registeredCapacityGB) × uptime_factor × latency_factor × spot_check_factor

uptime_factor    = heartbeat_blocks_today / 6       (max 1.0)
latency_factor   = 1000ms / avg_retrieval_latency   (max 1.0)
spot_check_factor = checks_passed / checks_received (max 1.0)
```

Rewards are based on **actual bytes stored**, not declared capacity. Each heartbeat block includes `actualStoredBytes` (read from `SmokeStore.storageUsedBytes()`). The reward is proportional to `min(actualStoredGB, registeredCapacityGB)` - the declared capacity is only an upper limit. Other nodes verify the amount against on-chain heartbeat data before accepting. Over-claiming is rejected by the ledger.

`registeredCapacityGB` (from `storage-register` block) is a soft limit the provider declares; it does not affect how much is paid - only actual bytes stored do. Use it to signal to uploaders how much space you can offer.

**Content distribution:** uploaders select up to 10 providers via weighted-random (weight = `min(capacityGB, 100) × score` - capped at 100 GB so one very large provider cannot monopolise selection), publish a signed `CacheRequest` via GossipSub (including the uploader's smoke Hub address so providers can reach the uploader over WebRTC), and providers fetch each block via smoke Http (HTTP-over-WebRTC) and write it to their local IndexedDB. Non-provider nodes that observe the `CacheRequest` also register the uploader's smoke address as a peer fallback so they can retrieve directly from the uploader if a provider is unavailable.

**Content deletion:** the owner broadcasts a signed `DeleteRequest` via GossipSub (`storage/delete-requests` topic). Any node that receives it - provider or non-provider - verifies the ECDSA signature against the owner's public key and immediately drops all local copies from IndexedDB. No restart required; deletion propagates across the mesh as fast as GossipSub delivers the message.

**Content replacement:** the owner stores new content locally (getting a new CID), then calls `replaceContent(oldCids, newCids, ownerPub, keys)`. This broadcasts a signed `ReplaceRequest` via GossipSub (`storage/replace-requests` topic). Every provider that holds the old CID verifies the signature, drops the old blocks, and fetches the new blocks from the owner via smoke Http. A new `CacheRequest` is also sent to ensure full replication to the target redundancy level. Storage rewards automatically reflect the change - each provider's next `storage-heartbeat` block reports updated `actualStoredBytes`, which feeds directly into reward calculation.

**Sybil resistance:** face-lock enforces 1 account per face on mainnet → 1 storage provider registration per person.

### Smart Contracts

JavaScript contracts execute in an isolated **sandboxed null-origin iframe** (`sandbox="allow-scripts"`, no `allow-same-origin`):

- **Null-origin isolation** - no access to same-origin localStorage, cookies, IndexedDB, or parent window
- Network globals (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval`, …) are overridden to `undefined` before any contract code runs
- **MessageChannel result channel** - the iframe receives a private `MessagePort` and replies exclusively through it; there is no `window.addEventListener('message')` in the parent, so other iframes or origins cannot inject fake results
- Execution timeout: 3 seconds (parent enforces with `setTimeout`)
- Contract calls on conflicted blocks are **deferred to idle time** (`requestIdleCallback` with 2s fallback) so they never block block validation
- Contract calls on conflicted blocks are deferred until conflict resolved
- Contract state is persistent across calls and survives page reloads (saved to IndexedDB on change)

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
function mint(metadata, cid) { ... }   // cid = SHA-256 CID of media content
function transfer(tokenId, to) { ... }
function ownerOf(tokenId) { ... }
function myTokens() { ... }
```

NFT media is stored via smoke FileSystem - the CID passed to `mint()` is a content pointer to the encrypted image/video/audio.

### dApp API

Build applications on NeuronChain using the `NeuronChainAPI` facade in [`src/api/neuronchain-api.ts`](src/api/neuronchain-api.ts). Key methods:

| Category | Method | Description |
|---|---|---|
| Content | `storeContent(data, mimeType, keys, name?)` | Store private (AES-256-GCM encrypted) content |
| Content | `storeContentPublic(data, mimeType, name?)` | Store public (unencrypted) content |
| Content | `retrieveContent(cid, keys)` | Retrieve + decrypt private content |
| Content | `retrieveContentPublic(cid)` | Retrieve public content |
| Content | `retrieveContentAuto(cid, keys?)` | Retrieve without knowing visibility |
| Content | `deleteContent(cids, ownerPub, keys)` | Delete locally + broadcast delete to all providers |
| Content | `replaceContent(oldCids, newCids, ownerPub, keys)` | Replace content in-place across the network |
| Content | `distributeContent(cids, pub, keys)` | Push CIDs to up to 10 storage providers |
| Transfers | `send(from, to, amount, keys)` | Send UNIT (amount in milli-UNIT) |
| Contracts | `deployContract(name, code, pub, keys)` | Deploy a JS sandbox contract |
| Contracts | `callContract(id, method, args, pub, keys)` | Call a contract method |
| Storage | `registerStorage(pub, capacityGB, keys)` | Register as a provider (auto heartbeats + rewards) |

### Two-Factor Key Protection (Face + PIN)

Account private keys are protected by **two independent cryptographic factors**. Both are required to recover keys - compromising one factor alone reveals nothing.

**Combined-key encryption (pinVersion=2):**
```
faceBytes  = PBKDF2-SHA256(quantizedDescriptor, "neuronchain-face-v2:<accountPub>", 100k)   32 bytes
pinBytes   = PBKDF2-SHA512(pin, pinSalt, 600k)                                               32 bytes
sharedKey  = AES-256-GCM key from XOR(faceBytes, pinBytes)
encryptedKeys = AES-GCM(sharedKey, KeyPair JSON)   ← single layer, blob.encryptedKeys
```

The face KDF salt is scoped per account (`neuronchain-face-v2:<accountPub>`), so the derived face bytes are unique even if two accounts share an identical face descriptor. This prevents cross-account rainbow tables.

Both factors are required to derive `sharedKey`. An attacker with the blob but only one factor sees a random-looking key - AES-GCM authentication always fails. Neither factor alone reveals the private keys.

**Face factor:**
- Liveness check (head movement detection, 15s timeout)
- Face enrollment - 3 captures averaged into a stable 128-dim canonical descriptor
- The canonical descriptor is PIN-encrypted and stored inside the blob (`encryptedCanonical`)
- Key derivation - quantize stored canonical → PBKDF2-SHA-256 (100K iterations) → 32 raw bytes

**Why recovery is reliable across devices and sessions:**

Face descriptors vary slightly between sessions due to lighting, angle, and distance. NeuronChain uses a stable canonical representation established at enrollment so the derived face key is consistent regardless of environment. Both factors are always required - neither alone is sufficient to decrypt the key blob.

**Face re-enrollment** (Update Face) re-derives new face bytes from the new enrollment, combines them with the cached session PIN bytes, and re-encrypts the in-memory keys under the new combined key - no blob decryption required. Changing PIN similarly re-derives a fresh combined key and re-encrypts in-memory. Both operations keep the blob consistent.

**PIN factor:**
- 4-digit numeric PIN set at account creation (per-account, independent)
- Key derivation - PBKDF2-SHA-512 (600,000 iterations, OWASP 2024 recommendation) → 32 raw bytes
- 32-byte random salt per account stored publicly in the key blob
- `pinVerifier = AES-GCM(pinKey, "PINOK")` stored in blob for fast in-app PIN feedback
- ~300ms per attempt in-browser; 10,000 PIN combinations × 300ms ≈ 50 min offline (learns PIN only - keys still require face)

**Privacy:**
- The canonical 128-dim face descriptor is PIN-encrypted inside the blob - never stored in plaintext
- `faceMapHash` (SHA-256 of quantized descriptor) remains public for duplicate detection
- `encryptedFaceDescriptor` in `Account` is PIN-ciphertext - unreadable without the PIN

**PIN-required actions:** send tokens, deploy contract, account recovery, update PIN/face  
**PIN-free actions:** contract calls (may originate from other accounts or external inputs)

**5-minute session cache:** after entering PIN (at login, recovery, or a transfer), the derived PIN key is held in memory for 5 minutes. Quick consecutive actions (multiple sends, deploy + call) do not re-prompt. Cleared on page close.

**On-chain binding - `linkedAnchor`:**
```
linkedAnchor = SHA-256(encryptedKeys + ":" + faceMapHash + ":" + pub)
```
Stored on-chain in the `open` block. Changing PIN or face requires a signed `update` block:
- Owner signs `update` block with their existing ECDSA key
- Block carries `updateData: { newFaceMapHash?, newLinkedAnchor, newPQPub?, newPQKemPub? }`
- Ledger verifies signature and recomputes anchor before accepting
- UI: Account tab → Update PIN / Face → authenticate → credentials updated on-chain

**On-chain storage** - encrypted blob stored on libp2p network + local IndexedDB  
**Backup** - compact Base58 secret key (~263 chars) shown once at creation; encodes both private keys (signing + encryption); recoverable without camera or PIN

### Quantum-Safe Hybrid Cryptography

Every new account generates a **hybrid key pair** combining classical and post-quantum algorithms:

| Key | Algorithm | Purpose |
|---|---|---|
| `pub` / `priv` | ECDSA P-256 | Block signing (classical) |
| `epub` / `epriv` | ECDH P-256 | Key agreement / content encryption (classical) |
| `pqPub` / `pqPriv` | ML-DSA-65 (CRYSTALS-Dilithium) | Block signing (quantum-safe) |
| `pqKemPub` / `pqKemPriv` | ML-KEM-768 (CRYSTALS-Kyber) | Key encapsulation (quantum-safe) |

PQ private keys live inside the face+PIN combined-key encrypted blob.  
PQ public keys (`pqPub`, `pqKemPub`) are stored on-chain in the `Account` object.

#### How ML-DSA-65 works (block signing)

ML-DSA-65 works like ECDSA - sign with the private key, verify with the public key - but the underlying math is based on **lattice problems** (Module Learning With Errors, MLWE) instead of elliptic curves. The private key is a short polynomial; the public key is derived from it via a structured matrix. Signing produces a "hint" vector; verification checks that hint against the public key and message hash.

Shor's algorithm (which breaks ECDSA by solving the discrete logarithm problem in polynomial time on a quantum computer) does not apply to MLWE. The best known quantum algorithm against lattice problems still requires exponential time.

Every block is signed with **both** ECDSA and ML-DSA-65. Both are verified on receipt. If ECDSA is ever broken by a quantum computer, ML-DSA-65 still holds.

#### How ML-KEM-768 works (content encryption)

ML-KEM-768 is a **Key Encapsulation Mechanism** - it establishes a shared secret between two parties, analogous to ECDH but quantum-safe. It does not encrypt content directly; it produces a shared secret that is then used as an AES-GCM key.

```
Alice publishes pqKemPub on-chain

Bob wants to send Alice encrypted content:
  { cipherText, sharedSecret } = encapsulate(alicePubKey)
  encrypted = AES-GCM(sharedSecret, content)
  → sends cipherText + encrypted to Alice

Alice decrypts:
  sharedSecret = decapsulate(cipherText, alicePrivKey)
  content = AES-GCM-decrypt(sharedSecret, encrypted)
```

The `cipherText` is a set of noisy polynomial equations over a polynomial ring. Only Alice's private key can remove the noise and recover the shared secret - again based on MLWE hardness.

#### Why quantum computers can't break these

Classical crypto (ECDSA, ECDH) relies on the **discrete logarithm problem** - Shor's algorithm solves it efficiently on a quantum computer. Lattice problems (MLWE) are a completely different mathematical structure. Shor's algorithm offers no advantage against them. Grover's algorithm gives at most a quadratic speedup on unstructured search but leaves lattice problems exponentially hard. Both ML-DSA and ML-KEM are NIST-standardised post-quantum algorithms (FIPS 204 and FIPS 203 respectively).

**Hybrid block signing:**
- Every block carries a classical `signature` (ECDSA P-256, always)
- Blocks from PQ-capable accounts also carry `pqSignature` (ML-DSA-65)
- Verification: ECDSA always checked; ML-DSA checked when both `pqSignature` and `pqPub` are present
- Legacy accounts (no PQ keys) are fully backward compatible - `pqSignature` is optional

Implementation uses `@noble/post-quantum` (pure TypeScript, no WASM).

### Exponential Backoff and Decentralised Lockout

Wrong PIN attempts trigger an exponential delay before the next attempt is allowed:

| Attempts | Delay |
|---|---|
| 1–3 | No delay |
| 4 | 30 seconds |
| 5 | 2 minutes |
| 6 | 8 minutes |
| 7 | 32 minutes |
| 8 | 2 hours |
| 9 | 8 hours |
| 10+ | 24 hours |

Formula: `delay_s = attempt > 3 ? Math.min(86400, 30 × 4^(attempt − 3)) : 0`

**Two-layer tamper-resistant persistence:**
1. **IndexedDB** `neuronchain-security / pinAttempts` - fast local check, keyed by account pub key
2. **Blob-embedded `pinAttemptState`** - face-key-encrypted `{ failedAttempts, lockedUntil }` inside the key blob - counter transfers to new devices and cannot be cleared without face auth

**Decentralised enforcement via GossipSub:**
- Topic: `neuronchain/{network}/lockouts`
- When attempt count crosses threshold (attempt ≥ 4): `LockoutNotice { accountPub, failedAttempts, lockedUntil, timestamp, signature }` is broadcast
- The notice is **ECDSA-signed by the account holder** over `lockout:<accountPub>:<failedAttempts>:<lockedUntil>:<timestamp>` - receiving peers verify the signature and reject unsigned or forged notices; only the account's own node can issue a valid lockout
- Receiving nodes store valid notices (capped at 10,000); blocks from locked accounts are held until lockout expires

**PIN session cache:** a 5-minute in-memory cache per account avoids re-prompting on quick consecutive actions (e.g., sending multiple transactions). Cleared on page close.

### Security

| Layer | Protection |
|---|---|
| Transport | Noise protocol (libp2p) - all peer connections encrypted + authenticated |
| Blocks | ECDSA P-256 + ML-DSA-65 hybrid signatures on every block |
| Accounts | ECDSA-signed account data - peers reject unsigned accounts |
| Votes | ECDSA-signed votes + balance proofs (`chainHeadHash` required; missing head = zero stake = vote dropped) |
| Inbox signals | ECDSA-signed by sender - recipients verify before accepting |
| Key storage | Combined key: AES-256-GCM(XOR(faceBytes, pinBytes)) - both factors required |
| Face KDF | Per-account salt `neuronchain-face-v2:<pub>` - unique bytes even if descriptors are identical |
| Key blob integrity | `linkedAnchor` SHA-256 stored on-chain - tamper detection on recovery |
| Face descriptor | Encrypted canonical stored in blob; live scan required as identity confirmation - both factors enforced |
| PIN brute force | PBKDF2-SHA-512 600K iterations + exponential backoff + decentralised lockout |
| Lockout notices | ECDSA-signed by account holder - peers reject unsigned or forged lockout broadcasts |
| Smart contracts | Null-origin iframe sandbox - no DOM/network/storage access; results returned via private MessageChannel port |
| Content | AES-256-GCM encryption before smoke storage |
| Range requests | 416 returned for out-of-bounds or inverted byte ranges |
| Generation governance | Mainnet resets require signed message from known operator keys |
| Null-write rejection | Client-side null-field guards on all received data |
| Balance/nonce gossip | Ledger ignores balance/nonce from account gossip - values are derived from blocks only |
| Balance overflow | `Number.isSafeInteger` validation on all amounts |
| Peer gossip rate limit | Token bucket per peer (50 cap, 10/s refill) - malicious peers cannot flood the message handler |
| Peer addresses | 10-minute TTL on discovered peer addresses - stale entries auto-evicted |
| Quantum-safe | ML-DSA-65 signatures + ML-KEM-768 key encapsulation alongside classical crypto |

## Technical Specs

| Spec | Value |
|---|---|
| Classical key pairs | ECDSA P-256 (signing) + ECDH P-256 (key agreement) via Web Crypto API |
| Quantum-safe keys | ML-DSA-65 (Dilithium, signing) + ML-KEM-768 (Kyber, encapsulation) |
| Block signing | Hybrid: ECDSA always + ML-DSA-65 when PQ keys present |
| Block hashing | SHA-256 (Web Crypto API) |
| Content encryption | AES-256-GCM, key via PBKDF2 from ECDH private key |
| Face key derivation | PBKDF2-SHA-256 (100K iterations) → 32 raw bytes |
| PIN key derivation | PBKDF2-SHA-512 (600K iterations, OWASP 2024) → 32 raw bytes |
| Key encryption | Combined: AES-256-GCM(XOR(faceBytes, pinBytes), KeyPairJSON); canonical descriptor PIN-encrypted in blob |
| Face descriptor | 128 dimensions (3-sample average), quantized to 0.05 bins; canonical stored encrypted in blob |
| PIN entropy hardening | 600K PBKDF2 iterations ≈ 300ms/attempt → 50min offline for 10K PINs |
| PIN backoff schedule | Attempts 1-3: none; 4: 30s; 5: 2m; 6: 8m; 7: 32m; 8: 2h; 9: 8h; 10+: 24h |
| Consensus | Optimistic confirmation + conflict-only stake-weighted voting (>2/3, 10s timeout) |
| P2P | libp2p - WebRTC, WebSockets, circuit relay v2, GossipSub, Kademlia DHT |
| Content storage | @sinclair/smoke - content-addressed (SHA-256 CIDs), encrypted, HTTP-over-WebRTC block transfer |
| Local persistence | IndexedDB - blocks, accounts, keyblobs, contracts survive relay downtime |
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
│   │   ├── crypto.ts             # Web Crypto API - ECDSA/ECDH/AES + ML-DSA-65/ML-KEM-768
│   │   ├── dag-block.ts          # Block types + hashing + validation + hybrid signing
│   │   ├── dag-ledger.ts         # Block-lattice state machine + update block handler
│   │   ├── vote.ts               # Stake-weighted voting + balance proofs
│   │   ├── account.ts            # Account model (includes PQ keys + linkedAnchor)
│   │   ├── face-verify.ts        # FaceID liveness + enrollment
│   │   ├── face-store.ts         # Combined-key encrypted blobs (face+PIN XOR) + linkedAnchor
│   │   ├── pin-crypto.ts         # PIN key derivation, exponential backoff, lockout state
│   │   └── events.ts             # EventEmitter
│   └── network/
│       ├── libp2p-network.ts     # libp2p + GossipSub + IndexedDB
│       ├── smoke-store.ts        # Smoke content storage (IndexedDB + HTTP-over-WebRTC)
│       ├── storage-manager.ts    # Storage deal lifecycle + 24h payments
│       └── node.ts               # NeuronNode - orchestrates all layers
├── relay-server.js               # libp2p relay + circuit relay v2 (Node.js)
├── vite-libp2p-plugin.ts         # Vite plugin: spawns relay in dev
├── vite.config.ts
├── index.html                    # Browser UI
└── package.json
```

## Remaining Architectural Notes

- **Bootstrap dependency**: libp2p still needs bootstrap nodes to find initial peers. Run multiple community bootstrap/relay nodes for mainnet.
- **Relay on gossipsub path**: while browser-to-browser connections run over circuit relay (before WebRTC upgrade), the relay node must also participate in GossipSub to route messages between those peers. Once peers upgrade to direct WebRTC, the relay is off the data path. For true relay-independence, run multiple independent community relays.
- **Auto-receive timing window**: `autoReceive` fires when the recipient's node receives the SEND block via GossipSub. If the recipient was briefly disconnected, the sender re-broadcasts every 20s so auto-receive will fire once they reconnect.
- **Waku alternative**: Waku (built on libp2p) provides a ready bootstrap fleet and built-in message store, but has a 150KB message size limit that prevents direct content storage. libp2p + smoke is the correct choice when storing arbitrary content.
- **Face uniqueness**: enforced locally via Euclidean distance on 128-dim descriptors. A global uniqueness proof (ZK biometrics) is an open research problem.
- **BFT finality**: optimistic confirmation with conflict voting is not BFT. Under a 33%+ Sybil attack, forks can persist. Full BFT (e.g., HotStuff) is a future upgrade path.

## GossipSub Compatibility Patches

libp2p and gossipsub ship as separate packages and their internal APIs drifted across minor versions. Three prototype-level patches are applied at startup (in both `relay-server.js` and `src/network/libp2p-network.ts`) to bridge the mismatches in the currently pinned versions:

**Fix A - `AbstractMessageStream` missing `.sink` / `.source`**  
New libp2p streams expose `Symbol.asyncIterator` + `send()` but not the `.sink` / `.source` duplex interface that `it-pipe` requires (`isDuplex(s) = s.sink != null && s.source != null`). Without this, gossipsub's `OutboundStream` constructor throws synchronously inside `createOutboundStream`, is silently caught, and `streamsOutbound` is never populated - no messages flow. Fixed by `Object.defineProperty(AbstractMessageStream.prototype, 'source/sink', ...)`.

**Fix B - `multiaddr.tuples()` API mismatch in `GossipSub.addPeer`**  
Gossipsub 14.x calls `multiaddr.tuples()` on peer addresses for IP scoring. When two different installations of `@multiformats/multiaddr` are resolved by Node (the common split-package scenario), libp2p's internal Multiaddr instances lack `.tuples()`, causing `addPeer()` to throw *before* `outboundInflightQueue.push()` - peers are never queued for stream creation. Fixed by wrapping `addPeer` in try/catch and manually inserting the peer into `this.peers`, `this.score`, and `this.outbound`.

**Fix C - `onIncomingStream` handler signature mismatch**  
This version of libp2p calls registered protocol handlers as `handler(stream, connection)` (two positional args). Gossipsub 14.x expects `handler({ stream, connection })` (one destructured object). The mismatch means `connection` is always `undefined` inside gossipsub, `createInboundStream` is never called, `streamsInbound` stays empty, subscriptions are never exchanged, the mesh never forms, and messages are never delivered. Fixed by patching `onIncomingStream` to detect the two-arg calling convention and wrap into the expected object form.
