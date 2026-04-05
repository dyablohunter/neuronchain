# NeuronChain

A browser-based blockchain using a **block-lattice DAG** with **stake-weighted voting** and **face-locked keys**. Everything runs in the browser — the Gun relay is embedded in the Vite dev server.

## Currency: Neuron Unit (UNIT)

- **1,000,000 UNIT** minted per account upon creation (FaceID mandatory)
- **3 decimal precision** (milli-UNIT) — smallest transferable unit is 0.001 UNIT
- All operations are **zero fee**
- Inflationary: total supply grows with each new account (limited to the total number of people)
- **Mainnet:** 1 account per face (1 human = 1 account)
- **Testnet:** up to 3 accounts per face (for testing)

## Quick Start

```bash
npm install
npm run dev        # Starts Vite + Gun relay on one port
npm run tunnel     # (second terminal) HTTPS tunnel for multiple devices testing
```

**For mobile:** open the tunnel URL (e.g., `https://xxx.trycloudflare.com`) on your phone.

### First Steps

1. **Create account** — Account tab → choose username → face scan → 1,000,000 UNIT minted
2. **Start node** — Node tab → Start Node (connects to Gun relay, starts syncing)
3. **Send UNIT** — Transfer tab → recipient username → amount
4. **Claim receives** — Transfer tab → Pending Receives → Claim
5. **Recover account** — Account tab → enter username → face scan (from any device)

### Important

- **Start Node first** on each device before creating accounts — ensures data syncs to the relay immediately
- Only **one tab per browser** is allowed (prevents account farming)
- Usernames are always **lowercase** (auto-converted)
- Accounts and blocks sync across devices every ~8 seconds via Gun relay polling

## Face-Locked Keys

Your private key is **encrypted with your face**. No seed phrases, no passwords.

### How It Works

1. Choose a username (3-24 chars, lowercase alphanumeric + dot)
2. **Liveness check** — slowly turn your head left/right (requires 30px nose travel + 2 direction reversals — prevents photo and video replay attacks)
3. **Face enrollment** — 3 captures averaged into a stable 128-D face descriptor (face-api.js, 99.38% accuracy)
4. Descriptor is **quantized** into stable bins for repeatability across sessions
5. Quantized descriptor → **PBKDF2** (100K iterations) → AES-256-GCM encryption key
6. ECDSA key pair is generated and **encrypted with the face-derived key**
7. Encrypted key blob is stored **on-chain via Gun** (available from any device worldwide)
8. A backup key pair JSON is shown once — save it as a secondary recovery method
9. Open block is created with face map hash → **1,000,000 UNIT minted**

### Account Recovery

Two methods:

- **FaceID (primary):** Enter username → encrypted key blob fetched from Gun → face scan → keys decrypted
- **Key pair JSON (backup):** Paste the JSON you saved at creation

### Privacy

- Face descriptors are quantized and used only to derive an AES key — never stored raw
- Only a SHA-256 hash of the face map goes on-chain
- The encrypted key blob is on-chain but useless without the matching face
- No images stored — only a 128-D numerical descriptor used transiently

## Block-Lattice DAG

Every account has its own chain. The first block (`open`) includes FaceID verification and mints 1M UNIT:

```
Alice:   [open +1M] → [send 50 to Bob] → [send 20 to Charlie]
Bob:     [open +1M] → [receive 50 from Alice]
Charlie: [open +1M] → [receive 20 from Alice]
```

Transfers require two blocks: a `send` on the sender's chain and a `receive` on the recipient's chain. Accounts transact in parallel.

### Block Types

| Type | Purpose | Balance Effect |
|------|---------|---------------|
| `open` | Account creation (FaceID + 1M UNIT mint) | +1,000,000 UNIT |
| `send` | Transfer UNIT to another account | -amount |
| `receive` | Accept UNIT from a confirmed send | +amount |
| `deploy` | Deploy a smart contract | No change |
| `call` | Call a smart contract method | No change |

### Optimistic Confirmation

Blocks are **confirmed instantly** if they pass local validation:

1. Block created → SHA-256 hashed → signed with ECDSA → **confirmed immediately** (no voting)
2. Block published to Gun relays (relay verifies signature server-side before storing) → propagates to other nodes
3. Other nodes validate signatures client-side and confirm optimistically (no vote needed)
4. **Only if a fork is detected** (two blocks with same parent) → stake-weighted voting triggers
5. Voting: peers vote weighted by **verified on-chain UNIT balance** — votes carry the voter's chain head hash as a balance proof, so receiving nodes can independently verify stake instead of trusting self-reported values → >2/3 stake wins → loser rejected
6. Vote signatures are verified **both** at the relay (spam filter) and at each receiving client (trust-independent verification)
7. Vote replay protection: duplicate signatures rejected, votes older than 60 seconds ignored

### Double-Spend Prevention

Two blocks from the same account with the same parent hash = fork. Peers detect this and vote on which to keep. The loser is rejected.

## P2P Networking

Gun.js handles all peer-to-peer communication using a **multi-relay, path-sharded architecture**:

```
Browser Node ──► Multiple Gun relays (configurable)
  ├── neuronchain/{network}/accounts/...         → account metadata (global)
  ├── neuronchain/{network}/votes/...            → conflict votes (global)
  ├── neuronchain/{network}/peers/...            → peer presence (global)
  ├── neuronchain/{network}/keyblobs/...         → encrypted key blobs (global)
  ├── neuronchain/{network}/contracts/...        → contracts (global)
  ├── neuronchain/{network}/synapse-0/dag/...    → blocks for hash(pub) % 4 === 0
  ├── neuronchain/{network}/synapse-1/dag/...    → blocks for hash(pub) % 4 === 1
  ├── neuronchain/{network}/synapse-2/dag/...    → blocks for hash(pub) % 4 === 2
  └── neuronchain/{network}/synapse-3/dag/...    → blocks for hash(pub) % 4 === 3
```

- **Multi-relay:** nodes connect to multiple independent Gun relays simultaneously for redundancy — if one relay censors or goes down, data propagates through others. Custom relays configurable via `localStorage.setItem('neuronchain_relays', JSON.stringify([...]))`
- **Path-sharded:** block data split across 4 synapse paths by `hash(pub) % 4`
- **Global data:** accounts, votes, peers, key blobs, contracts share the same relay
- **Production scaling:** synapse paths map 1:1 to separate relay URLs — point each at a different server when needed
- **Single command:** `npm run dev` starts Vite + Gun relay
- **Cross-device:** `npm run tunnel` for HTTPS multiple devices access
- **On-demand resync:** nodes resync when switching to relevant tabs, with a 60-second background fallback
- **Single-tab lock:** one node per browser (prevents account farming)
- **Auto-receive:** incoming sends to local accounts are claimed automatically
- **Signed inbox signals:** senders sign notifications with their ECDSA key; recipients verify the signature before processing — prevents relay fabrication of fake transfer notifications

## Features

- **Face-locked keys** — private key encrypted with face-derived AES-256 key
- **Face recovery** — scan face on any device to decrypt keys from the chain
- **Key blob integrity** — encrypted key blobs include a SHA-256 content hash stored on-chain; on recovery, the hash is verified to detect relay tampering
- **Backup key pair** — JSON key pair shown at creation for secondary recovery
- **1M UNIT per account** — inflationary, minted at creation
- **Zero fees** — all operations free
- **Block-lattice DAG** — per-account chains, parallel transactions
- **SHA-256 block hashing** — all block hashes computed via Web Crypto API
- **Optimistic confirmation** — blocks confirmed instantly, voting only on conflicts
- **Double-spend prevention** — fork detection triggers stake-weighted voting with verified on-chain balances
- **Balance proofs in votes** — votes include the voter's chain head hash so receiving nodes can independently verify the voter's balance instead of trusting self-reported stake
- **Client-side vote verification** — all incoming votes are cryptographically verified client-side before acceptance, not just by the relay
- **Vote replay protection** — duplicate signatures rejected, stale votes ignored
- **Multi-relay P2P** — nodes connect to multiple independent Gun relays for redundancy; custom relays configurable via localStorage
- **Server-side validation** — relay verifies ECDSA signatures on blocks, accounts, and votes before storing
- **Rate limiting** — per-connection write limits on the relay (60 burst, 20/s sustained)
- **Null write protection** — malicious null writes blocked both server-side (relay middleware) and client-side (Gun listeners reject null critical fields)
- **Signed accounts** — account data ECDSA-signed by owner, verified by peers and relay
- **Signed inbox signals** — transfer notifications are ECDSA-signed by the sender; recipients verify before processing
- **Movement liveness** — head movement + direction reversal detection prevents photo/video attacks
- **Smart contracts** — JavaScript in isolated Web Worker sandbox (3s timeout, no DOM/network access)
- **Encrypted local wallet** — keys in localStorage encrypted with per-session AES-256 key
- **Balance overflow protection** — all values validated against safe integer range
- **Generation governance** — testnet resets increment generation counter (any client); mainnet resets require a signed message from a known operator key
- **XSS protection** — all peer-supplied data HTML-escaped before rendering
- **Keep-alive** — Wake Lock + Web Worker + silent audio prevents tab freezing
- **Single-tab lock** — one node per browser
- **Testnet reset** — wipe all data and start fresh

## Tabs

| Tab | Description |
|-----|-------------|
| **Node** | Start/stop node, start/stop validating, node stats, relay connection, live log |
| **Explorer** | Sync status, block list with lazy loading, search by hash or username, vote tallies |
| **Accounts** | Create account with FaceID, recover by face or key pair, view balances |
| **Transfer** | Send UNIT, claim pending receives *(requires running node)* |
| **Contracts** | Deploy and call JavaScript smart contracts *(requires running node)* |
| **Chain** | Network stats, DAG overview, recent blocks, testnet reset |
| **Help** | Full documentation |

**Note:** Transfer and Contracts tabs are disabled until the node is started.

## Architecture

```
src/
  core/
    crypto.ts       — Gun SEA: ECDSA key pairs, signing, SHA-256
    face-verify.ts  — face-api.js: detection, descriptors, quantization, AES key derivation
    face-store.ts   — Face-encrypted key blob creation and recovery
    dag-block.ts    — AccountBlock types (open, send, receive, deploy, call)
    dag-ledger.ts   — Block-lattice ledger: account chains, balances, contracts
    vote.ts         — Stake-weighted voting: tallies, conflict detection, confirmation
    account.ts      — Account model with faceMapHash
    events.ts       — Event emitter
    keepalive.ts    — Wake Lock + Web Worker + silent audio
    tab-lock.ts     — Single-tab lock (prevents multi-tab account farming)
  network/
    gun-network.ts  — Gun.js P2P: block/vote/account sync, key blob storage
    node.ts         — Node controller: auto-voting, auto-receiving, resync polling
  main.ts           — UI controller
vite-gun-plugin.ts  — Vite plugin: embeds Gun relay in dev server
gun-middleware.ts   — Server-side: signature validation, rate limiting, null write protection
```

## Tech Stack

- **TypeScript** + **Vite** — build toolchain
- **Gun.js** — P2P networking, data sync, persistence, embedded relay
- **Gun SEA** — ECDSA/ECDH cryptography, signing, verification
- **face-api.js** — face detection, 128-D descriptors (99.38% accuracy on LFW)
- **Web Crypto API** — AES-256-GCM encryption, PBKDF2 key derivation
- **untun** — Cloudflare tunnel for multiple devices HTTPS access
- **Wake Lock API** + **Web Workers** + **AudioContext** — tab keep-alive

## Development

```bash
npm install          # Install dependencies
npm run dev          # Start dev server + Gun relay
npm run tunnel       # HTTPS tunnel for multiple devices testing
npm run build        # Production build to dist/
npm run preview      # Preview production build
```

### Networks

| | Testnet | Mainnet |
|---|---------|---------|
| UNIT per account | 1,000,000 | 1,000,000 |
| Accounts per face | 3 | 1 |
| Fees | Zero | Zero |
| Reset | Yes | No |

### Production Deployment

For production, deploy with a proper domain and SSL certificate. The Gun relay needs to be accessible from all nodes — either embedded in the same server or as a separate Gun relay instance.

## Technical Specifications

### Currency

| Property | Value |
|----------|-------|
| Name | Neuron Unit |
| Symbol | UNIT |
| Decimals | 3 (milli-UNIT precision) |
| Smallest unit | 0.001 UNIT |
| Mint per account | 1,000,000 UNIT |
| Fees | Zero (all operations free) |

### Cryptography

| Component | Algorithm |
|-----------|-----------|
| Key pairs | ECDSA (Gun SEA) |
| Signing | ECDSA SHA-256 |
| Face key derivation | PBKDF2 (100K iterations) → AES-256-GCM |
| Block hashing | SHA-256 (Web Crypto API, 64 hex chars) |
| Face map hash | SHA-256 (Web Crypto API) |
| Local wallet encryption | AES-256-GCM (per-session key in sessionStorage) |
| Account authentication | ECDSA-signed account data, verified by peers and relay |

### Consensus: Optimistic Confirmation

| Property | Value |
|----------|-------|
| Type | Block-lattice DAG with optimistic confirmation |
| Normal blocks | **Confirmed instantly** (no voting needed) |
| Conflict blocks | Stake-weighted voting (verified on-chain balance), >2/3 threshold |
| Balance proofs | Votes carry voter's chain head hash; receivers verify balance independently |
| Vote verification | Signatures verified both server-side (relay) and client-side (each node) |
| Conflict timeout | 10 seconds (highest stake wins) |
| Fork detection | Two blocks with same parent = conflict |
| Vote replay protection | Signature deduplication + 60s staleness window |
| Balance validation | All values checked against `Number.isSafeInteger` |
| Block types | open, send, receive, deploy, call |

**How it works:** Blocks are confirmed the moment they pass local validation (valid SHA-256 hash, ECDSA signature, sufficient balance, no fork). No voting, no waiting. Voting only engages when a **fork is detected** (two blocks sharing the same parent hash = double-spend attempt). Votes include a balance proof (the voter's chain head hash) so receiving nodes can independently verify the voter's stake from their local ledger, rather than trusting self-reported values. Vote signatures are verified at both the relay and each client node. 99.9% of blocks confirm instantly.

### Estimated Performance

With optimistic confirmation, throughput scales with the number of active accounts:

| Nodes | Estimated TPS | Confirmation Time | Notes |
|-------|--------------|-------------------|-------|
| **~100** | 5,000-10,000 | **<1ms local** / 1-3s cross-device | Relay fan-out is the bottleneck |
| **~1,000** | 1,000-5,000 | **<1ms local** / 3-8s cross-device | Multiple relays recommended |
| **~10,000** | 500-2,000 | **<1ms local** / 5-15s cross-device | Synapse relays needed |

**Why it's fast:**
- **Optimistic confirmation** — no voting for uncontested blocks (99.9% of transactions)
- **Block-lattice parallelism** — Alice→Bob doesn't block Charlie→Dave; TPS scales with active accounts
- **Local finality in <1ms** — the block is applied to local state immediately on creation
- **Cross-device propagation** — limited by Gun relay throughput (on-demand resync, 60s fallback)
- **Conflict-only voting** — voting overhead only incurred during actual double-spend attempts

### Network

| Property | Value |
|----------|-------|
| P2P protocol | Gun.js (WebSocket) |
| Relay architecture | **Multi-relay, path-sharded** — multiple Gun relays, 4 synapse paths + global (scalable to separate servers) |
| Multi-relay | Nodes connect to multiple independent relays simultaneously; configurable via localStorage |
| Synapse routing | `hash(accountPub) % NUM_SYNAPSES` |
| Global path | Accounts, votes, peers, key blobs, contracts |
| Synapse paths | Block data (each handles 1/N of accounts) |
| Server-side validation | ECDSA signature verification on all blocks, accounts, and votes |
| Client-side validation | All incoming blocks, votes, and inbox signals are signature-verified client-side |
| Rate limiting | Token bucket: 60 burst, 20 writes/s per connection |
| Null write protection | `put(null)` blocked on protected paths (relay-side) + null critical fields rejected (client-side) |
| Inbox signals | ECDSA-signed by sender, verified by recipient |
| Key blob integrity | SHA-256 content hash stored on-chain, verified on recovery |
| Generation governance | Testnet: any client; Mainnet: requires signed message from known operator |
| Sync method | Real-time listeners + signed inbox signals + on-demand resync (60s fallback) |
| Peer discovery | Gun relay peer tracking |
| Data persistence | Gun server-side file storage |
| Tab limit | 1 per browser (prevents account farming) |

### Face Recognition

| Property | Value |
|----------|-------|
| Library | face-api.js |
| Accuracy | 99.38% (LFW benchmark) |
| Descriptor size | 128 dimensions (float) |
| Quantization | Binned to 0.05 increments |
| Liveness | 30px nose travel + 2 direction reversals (15s timeout) |
| Key encryption | AES-256-GCM with face-derived key |
| Storage | Encrypted blob on Gun relay (signed by owner); hash on-chain |

## Security

### Relay Protection

The Gun relay runs server-side middleware (`gun-middleware.ts`) that intercepts all incoming writes:

- **Signature verification** — blocks, accounts, and votes must carry valid ECDSA signatures matching their claimed author. Unsigned or spoofed data is rejected before storage.
- **Rate limiting** — token bucket per connection (60 write burst, 20 writes/s sustained). Flooding clients are silently dropped.
- **Null write protection** — `put(null)` to protected paths (accounts, keyblobs, contracts, votes, inbox) is blocked unless accompanied by a generation counter bump (testnet reset).
- **Stats endpoint** — `/gun-stats` exposes accepted/rejected counts for monitoring.

### Client-Side Protection

- **SHA-256 block hashing** — all block hashes via Web Crypto API (not a custom hash)
- **ECDSA signature verification** — every block verified on receipt before adding to the ledger
- **Client-side vote signature verification** — all incoming votes are cryptographically verified client-side (not just by the relay), so a malicious relay cannot fabricate or alter votes
- **Balance proofs** — votes include the voter's chain head block hash; receiving nodes look up the block and use its balance as the verified stake, preventing stake inflation attacks
- **Signed account data** — account records include an ECDSA signature; peers reject unsigned or mismatched accounts
- **Signed inbox signals** — transfer notifications are ECDSA-signed by the sender; recipients verify signatures before processing, preventing relay fabrication of fake notifications
- **Null write rejection** — clients reject data from Gun where critical fields (hash, accountPub, signature, etc.) are `null`, complementing the server-side null write protection
- **Key blob integrity verification** — encrypted key blobs include a SHA-256 content hash stored in on-chain account data; during recovery, the loaded blob's hash is verified against the on-chain hash to detect tampering by a malicious relay
- **Vote replay protection** — duplicate vote signatures are rejected; votes older than 60 seconds are ignored
- **Balance overflow protection** — all balances and amounts validated against `Number.isSafeInteger`
- **Validate-before-store** — blocks are fully validated (signature, structure, conflicts) before being added to the ledger
- **Contract sandboxing** — smart contracts execute in an isolated Web Worker with no DOM, localStorage, fetch, or network access; terminated after 3 seconds
- **Encrypted local wallet** — private keys in localStorage are AES-256-GCM encrypted with a per-session key stored in sessionStorage
- **Generation governance** — testnet resets are open (any client can increment generation); mainnet generation bumps require a signed message from a key in the `KNOWN_OPERATORS` list, preventing unilateral network wipes
- **XSS prevention** — all peer-supplied data (usernames, hashes, contract names) is HTML-escaped before rendering
- **Single-tab lock** — one node per browser via localStorage heartbeat

## License

See [LICENSE](LICENSE).
