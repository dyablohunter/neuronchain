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
npm run tunnel     # (second terminal) HTTPS tunnel for mobile camera access
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
2. **Liveness check** — slowly turn your head left/right (movement detection prevents photo attacks)
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

1. Block created → signed with ECDSA → **confirmed immediately** (no voting)
2. Block published to Gun relay → propagates to other nodes
3. Other nodes validate and confirm optimistically (no vote needed)
4. **Only if a fork is detected** (two blocks with same parent) → stake-weighted voting triggers
5. Voting: peers vote weighted by UNIT balance → >2/3 stake wins → loser rejected

### Double-Spend Prevention

Two blocks from the same account with the same parent hash = fork. Peers detect this and vote on which to keep. The loser is rejected.

## P2P Networking

Gun.js handles all peer-to-peer communication using a **sharded relay architecture**:

```
Browser Node
  ├── /gun/global    → accounts, votes, peers, key blobs (shared)
  ├── /gun/shard/0   → blocks for accounts where hash(pub) % 4 === 0
  ├── /gun/shard/1   → blocks for accounts where hash(pub) % 4 === 1
  ├── /gun/shard/2   → blocks for accounts where hash(pub) % 4 === 2
  └── /gun/shard/3   → blocks for accounts where hash(pub) % 4 === 3
```

- **Sharded:** block data is distributed across 4 Gun relay instances by account pub key hash
- **Global relay:** shared data (accounts, votes, peers, key blobs, contracts)
- **Linear scaling:** each shard handles 1/4 of total block throughput; add more shards for more capacity
- **Single command:** `npm run dev` starts Vite + all 5 Gun relays
- **Cross-device:** `npm run tunnel` for HTTPS mobile access
- **Periodic resync:** every 8 seconds, nodes poll all shards for missed data
- **Single-tab lock:** one node per browser (prevents account farming)
- **Auto-receive:** incoming sends to local accounts are claimed automatically

## Features

- **Face-locked keys** — private key encrypted with face-derived AES-256 key
- **Face recovery** — scan face on any device to decrypt keys from the chain
- **Backup key pair** — JSON key pair shown at creation for secondary recovery
- **1M UNIT per account** — inflationary, minted at creation
- **Zero fees** — all operations free
- **Block-lattice DAG** — per-account chains, parallel transactions
- **Optimistic confirmation** — blocks confirmed instantly, voting only on conflicts
- **Double-spend prevention** — fork detection triggers stake-weighted voting
- **Gun.js P2P** — embedded relay, cross-device sync
- **Movement liveness** — head movement detection prevents photo/deepfake attacks
- **Smart contracts** — JavaScript with persistent state
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
```

## Tech Stack

- **TypeScript** + **Vite** — build toolchain
- **Gun.js** — P2P networking, data sync, persistence, embedded relay
- **Gun SEA** — ECDSA/ECDH cryptography, signing, verification
- **face-api.js** — face detection, 128-D descriptors (99.38% accuracy on LFW)
- **Web Crypto API** — AES-256-GCM encryption, PBKDF2 key derivation
- **untun** — Cloudflare tunnel for mobile HTTPS access
- **Wake Lock API** + **Web Workers** + **AudioContext** — tab keep-alive

## Development

```bash
npm install          # Install dependencies
npm run dev          # Start dev server + Gun relay
npm run tunnel       # HTTPS tunnel for mobile (second terminal)
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
| Block hashing | Deterministic sync hash (64 hex chars) |
| Face map hash | SHA-256 (Web Crypto API) |

### Consensus: Optimistic Confirmation

| Property | Value |
|----------|-------|
| Type | Block-lattice DAG with optimistic confirmation |
| Normal blocks | **Confirmed instantly** (no voting needed) |
| Conflict blocks | Stake-weighted voting, >2/3 threshold |
| Conflict timeout | 10 seconds (highest stake wins) |
| Fork detection | Two blocks with same parent = conflict |
| Block types | open, send, receive, deploy, call |

**How it works:** Blocks are confirmed the moment they pass local validation (valid signature, sufficient balance, no fork). No voting, no waiting. Voting only engages when a **fork is detected** (two blocks sharing the same parent hash = double-spend attempt). 99.9% of blocks confirm instantly.

### Estimated Performance

With optimistic confirmation, throughput scales with the number of active accounts:

| Nodes | Estimated TPS | Confirmation Time | Notes |
|-------|--------------|-------------------|-------|
| **~100** | 5,000-10,000 | **<1ms local** / 1-3s cross-device | Relay fan-out is the bottleneck |
| **~1,000** | 1,000-5,000 | **<1ms local** / 3-8s cross-device | Multiple relays recommended |
| **~10,000** | 500-2,000 | **<1ms local** / 5-15s cross-device | Sharded relays needed |

**Why it's fast:**
- **Optimistic confirmation** — no voting for uncontested blocks (99.9% of transactions)
- **Block-lattice parallelism** — Alice→Bob doesn't block Charlie→Dave; TPS scales with active accounts
- **Local finality in <1ms** — the block is applied to local state immediately on creation
- **Cross-device propagation** — limited by Gun relay throughput (~8s polling interval)
- **Conflict-only voting** — voting overhead only incurred during actual double-spend attempts

### Network

| Property | Value |
|----------|-------|
| P2P protocol | Gun.js (WebSocket) |
| Relay architecture | **Sharded** — 4 shard relays + 1 global relay |
| Shard routing | `hash(accountPub) % NUM_SHARDS` |
| Global relay | Accounts, votes, peers, key blobs, contracts |
| Shard relays | Block data (each shard handles 1/N of accounts) |
| Sync method | Real-time listeners + 8s polling |
| Peer discovery | Gun relay peer tracking |
| Data persistence | Gun server-side file storage (per shard) |
| Tab limit | 1 per browser (prevents account farming) |

### Face Recognition

| Property | Value |
|----------|-------|
| Library | face-api.js |
| Accuracy | 99.38% (LFW benchmark) |
| Descriptor size | 128 dimensions (float) |
| Quantization | Binned to 0.05 increments |
| Liveness | Head movement detection (nose landmark tracking) |
| Key encryption | AES-256-GCM with face-derived key |
| Storage | Encrypted blob on Gun relay; hash on-chain |

## License

See [LICENSE](LICENSE).
