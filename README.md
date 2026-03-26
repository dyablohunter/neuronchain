# NeuronChain

A browser-based blockchain using a **block-lattice DAG** with **stake-weighted voting** and **face-locked keys**. Everything runs in the browser — the Gun relay is embedded in the Vite dev server.

## Currency: Neuron Unit (UNIT)

- **1,000,000 UNIT** minted per account upon creation (FaceID mandatory)
- All operations are **zero fee**
- Inflationary: total supply grows with each new account
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

### Stake-Weighted Voting

1. Block created → signed with ECDSA → published to Gun relay
2. Peers validate (signature, balance, no fork) → auto-vote (weight = UNIT balance)
3. \>2/3 of online stake approves → **confirmed**
4. Uncontested blocks auto-confirm after 10 seconds (grace period)
5. Fork conflict → highest stake wins, loser rejected and rolled back

### Double-Spend Prevention

Two blocks from the same account with the same parent hash = fork. Peers detect this and vote on which to keep. The loser is rejected.

## P2P Networking

Gun.js handles all peer-to-peer communication. The Gun relay runs embedded in the Vite dev server (same port, same process).

- **Single command:** `npm run dev` starts both Vite and the Gun relay
- **Cross-device:** use `npm run tunnel` for an HTTPS URL accessible from mobile
- **Data sync:** accounts, blocks, votes, and encrypted key blobs sync via Gun relay
- **Periodic resync:** every 8 seconds, each node polls Gun for missed data
- **Single-tab lock:** only one node per browser (prevents account farming)
- **Auto-vote:** peers automatically vote on valid blocks they receive
- **Auto-receive:** incoming sends addressed to local accounts are automatically claimed

## Features

- **Face-locked keys** — private key encrypted with face-derived AES-256 key
- **Face recovery** — scan face on any device to decrypt keys from the chain
- **Backup key pair** — JSON key pair shown at creation for secondary recovery
- **1M UNIT per account** — inflationary, minted at creation
- **Zero fees** — all operations free
- **Block-lattice DAG** — per-account chains, parallel transactions
- **Stake-weighted voting** — blocks confirmed by balance-weighted peer vote
- **Double-spend prevention** — fork detection + majority vote
- **Gun.js P2P** — embedded relay, cross-device sync
- **Movement liveness** — head movement detection prevents photo/deepfake attacks
- **Smart contracts** — JavaScript with persistent state
- **Keep-alive** — Wake Lock + Web Worker + silent audio prevents tab freezing
- **Single-tab lock** — one node per browser
- **Testnet reset** — wipe all data and start fresh

## Tabs

| Tab | Description |
|-----|-------------|
| **Chain** | Network stats, DAG overview, recent blocks with confirmation status, testnet reset |
| **Node** | Start/stop node, start/stop validating, node stats, relay connection, live log |
| **Account** | Create account with FaceID, recover by face or key pair, view balances |
| **Transfer** | Send UNIT, claim pending receives |
| **Explorer** | Search by block hash or username, view account chains and vote tallies |
| **Contracts** | Deploy and call JavaScript smart contracts |
| **Help** | Full documentation |

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

## License

See [LICENSE](LICENSE).
