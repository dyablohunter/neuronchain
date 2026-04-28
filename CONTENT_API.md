# NeuronChain Content & dApp API

The `NeuronChainAPI` class is a clean, stable facade for building decentralised applications on NeuronChain. Import it instead of accessing `NeuronNode` internals directly.

## Installation

```typescript
import { NeuronChainAPI } from './src/api/neuronchain-api';
```

## Quick Start

```typescript
const api = new NeuronChainAPI('testnet');
await api.start();

// Register a local key so the node can auto-receive and auto-vote
api.registerKey(pub, keys);

// Transfer UNIT
await api.send(fromPub, 'alice', 100_000, keys);  // 100 UNIT

// Store private content (encrypted) — returns a ContentHandle with the CID
const handle = await api.storeContent(imageBytes, 'image/jpeg', keys, 'my-photo.jpg');

// Distribute to up to 10 network storage providers
await api.distributeContent([handle.cid, handle.contentCid].filter(Boolean) as string[], myPub, keys);

// Retrieve and decrypt
const bytes = await api.retrieveContent(handle.cid, keys);

// Delete from local storage + all providers immediately
await api.deleteContent([handle.cid, handle.contentCid].filter(Boolean) as string[], myPub, keys);

// Deploy a contract
const { contractId } = await api.deployContract('MyNFT', nftCode, pub, keys);

// Call a contract
await api.callContract(contractId, 'mint', ['My Artwork', handle.cid], pub, keys);

// Earn UNIT by offering storage
await api.registerStorage(pub, 100, keys);  // offer 100 GB

// Events
api.on('block:confirmed',       (block) => console.log('Confirmed!', block));
api.on('storage:reward-issued', ({ amount }) => console.log('Reward:', amount, 'milli-UNIT'));
```

---

## How Content Storage Works

### The meta-envelope pattern

Every `store*` call creates **two separate blocks** in IndexedDB, each with its own SHA-256 CID:

```
┌──────────────────────────────────────────────────────────┐
│  Meta block  (metaCid)                                   │
│  { mimeType, size, encrypted, timestamp, contentCid }    │
└───────────────────────────┬──────────────────────────────┘
                            │ contentCid points to ↓
┌───────────────────────────▼──────────────────────────────┐
│  Content block  (contentCid)                             │
│  Raw bytes (public) or AES-256-GCM ciphertext (private)  │
└──────────────────────────────────────────────────────────┘
```

The CID returned to the caller is always the **meta CID**. Passing only the meta CID to retrieval methods is sufficient — the meta block contains `contentCid` internally so the library fetches the content block automatically.

When distributing content to providers you should pass **both CIDs** so providers cache both blocks independently and can serve a complete retrieval without ever contacting the original uploader:

```typescript
const handle = await api.storeContent(data, 'image/jpeg', keys);
// handle.cid        = meta CID   (the envelope)
// handle.contentCid = content CID (the actual data block)

const cids = [handle.cid, handle.contentCid].filter(Boolean) as string[];
await api.distributeContent(cids, myPub, keys);
```

### CID format

All CIDs are SHA-256 content-addressed identifiers in `bafkrei…` format (CIDv1 raw codec via `multiformats`). The hash is computed over the exact bytes stored — for private content, that means the ciphertext. This means any peer serving a single wrong byte is detected and rejected at retrieval time.

### Peer-to-peer block transfer

Content is served directly by NeuronChain peers using `@sinclair/smoke` — there is no dependency on the public IPFS network.

```
Node A (uploader)                       Node B (provider / downloader)
────────────────                        ──────────────────────────────
store(data)                             Receives CacheRequest via GossipSub
→ writes /blocks/<cid> in IndexedDB      with A's smoke Hub address
→ publishes CacheRequest via GossipSub  → smoke Http.fetch('http://<A-hub>:5891/block/<cid>')
   includes: A's smoke Hub address       uses WebRTC data channel (hub = WebSocket signaling)
   includes: target provider pub keys   → writes /blocks/<cid> in IndexedDB
                                        → writes /cached/<cid> marker
                                        → broadcasts StorageReceipt with B's Hub address

Node C (retriever, not a provider)
──────────────────────────────────
Observes CacheRequest  → registers A's Hub address as peer fallback
Observes StorageReceipt → registers B's Hub address as peer fallback
retrieve(cid):
  1. Check /blocks/<cid> in local IndexedDB → hit: return immediately
  2. Miss: Http.fetch from A or B in parallel over WebRTC
  3. Winner's bytes written to /blocks/<cid> for future local access
```

The smoke Hub address (a UUID assigned at node startup) identifies a node for WebRTC connections. Hub addresses are exchanged through the relay server's `/smoke-hub` WebSocket endpoint, which acts as a signaling layer for WebRTC ICE negotiation. Once ICE is complete, block transfer is fully peer-to-peer — the relay server is not on the data path.

### Visibility modes

| Visibility | Store method | Retrieve method | Who can read |
|---|---|---|---|
| **Private** | `storeContent` | `retrieveContent` | Only the key holder |
| **Public** | `storeContentPublic` | `retrieveContentPublic` | Anyone with the CID |
| **Unknown** | — | `retrieveContentAuto` | Tries decryption first, falls back to public |

Private content uses AES-256-GCM with a key derived from the account's ECDH private key via PBKDF2. The same key is always derived from the same private key, so content is decryptable on any device where the account keys are loaded.

---

## Content Storage Methods

### `storeContent(data, mimeType, keys, name?)` — private

Encrypt with AES-256-GCM and store. Only the key holder can decrypt.

```typescript
const handle = await api.storeContent(
  imageBytes,        // Uint8Array
  'image/jpeg',      // MIME type
  keys,              // KeyPair (ECDSA + ECDH)
  'my-photo.jpg',    // optional display name
);

console.log(handle.cid);         // meta CID — use in blocks or contracts
console.log(handle.contentCid);  // inner content CID — pass to distributeContent
console.log(handle.size);        // original byte length (before encryption)
console.log(handle.mimeType);    // 'image/jpeg'
console.log(handle.timestamp);   // Unix ms
```

### `storeContentPublic(data, mimeType, name?)` — public

Store without encryption. Anyone with the CID can read. The CID can be shared publicly or embedded in a contract.

```typescript
const handle = await api.storeContentPublic(
  new TextEncoder().encode(JSON.stringify({ title: 'Hello', body: '...' })),
  'application/json',
  'my-post',
);
console.log(handle.cid);  // share this CID publicly
```

### `retrieveContent(cid, keys)` — private

Retrieve and decrypt private content by meta CID. Throws if the content is not found or decryption fails.

```typescript
const bytes = await api.retrieveContent(handle.cid, keys);
const blob = new Blob([bytes], { type: 'image/jpeg' });
document.querySelector('img')!.src = URL.createObjectURL(blob);
```

### `retrieveContentPublic(cid)` — public

Retrieve public content by meta CID. No keys required.

```typescript
const bytes = await api.retrieveContentPublic(cid);
const post = JSON.parse(new TextDecoder().decode(bytes));
```

### `retrieveContentAuto(cid, keys?)` — auto-detect

Retrieve without knowing whether the content was stored as public or private. Tries decryption first (if keys provided), then falls back to public read.

```typescript
const result = await api.retrieveContentAuto(cid, keys);
if (result) {
  console.log(result.wasEncrypted);  // true = was private, false = public
  console.log(result.mimeType);      // from the meta block
  console.log(result.size);          // original byte count
  // result.data is a Uint8Array
}
```

### `storeJSON(data, keys)` — private, returns CID string

Store any JSON-serialisable object, encrypted. Returns the meta CID directly (no `ContentHandle`).

```typescript
const cid = await api.storeJSON(
  { title: 'Hello', body: 'World', tags: ['web3'], ts: Date.now() },
  keys,
);
```

### `retrieveJSON<T>(cid, keys)` — private

Retrieve and parse a JSON object. Returns `undefined` if not found or decryption fails.

```typescript
interface Post { title: string; body: string; tags: string[]; ts: number }
const post = await api.retrieveJSON<Post>(cid, keys);
```

### `storeText(text, keys)` — private, returns CID string

Store any text (HTML, CSS, JS, Markdown) encrypted.

```typescript
const cid = await api.storeText('<html><body>My dApp</body></html>', keys);
```

### `retrieveText(cid, keys)` — private

Retrieve and decode text content. Returns `undefined` if not found or decryption fails.

```typescript
const html = await api.retrieveText(cid, keys);
```

---

## Distributing and Deleting Content

### `distributeContent(cids, uploaderPub, keys)`

Push content to up to 10 network storage providers, chosen by weighted-random selection (weight = `capacityGB × score`). Each provider fetches the blocks via smoke Http (HTTP-over-WebRTC) and writes them to their local IndexedDB.

Always pass **both** the meta CID and the inner content CID:

```typescript
const cids = [handle.cid, handle.contentCid].filter(Boolean) as string[];
const { providers, error } = await api.distributeContent(cids, myPub, keys);

if (error) {
  // No providers registered yet — content is safe locally.
  // StorageManager will retry automatically when a provider comes online.
  console.warn(error);
} else {
  console.log(`Replicated to ${providers.length} provider(s)`);
}
```

Internally, distribution publishes a `CacheRequest` message via GossipSub containing:
- All target provider public keys
- The uploader's smoke Hub address (providers use this for WebRTC peer connection)
- An ECDSA signature by the uploader

Non-provider nodes that observe the `CacheRequest` also register the uploader's smoke address as a retrieval fallback. Providers that successfully cache a block broadcast a `StorageReceipt` containing their own smoke address, giving other nodes yet another fallback source.

If GossipSub delivery fails (e.g. mesh not fully formed), `StorageManager` retries the cache request every 30 seconds until at least one provider confirms.

### `deleteContent(cids, ownerPub, keys)`

Delete content from the local node's IndexedDB and broadcast a signed `DeleteRequest` via GossipSub so all peers drop their copies immediately — no restart required.

```typescript
const cids = [record.cid, record.contentCid].filter(Boolean) as string[];
await api.deleteContent(cids, myPub, myKeys);
// Content is gone locally within milliseconds.
// Connected peers receive the delete request via GossipSub and drop their copies.
```

What each receiving node does:
1. Verifies the ECDSA signature against `ownerPub`
2. Deletes each CID from `/blocks/` and `/cached/` in IndexedDB
3. Removes the entry from the distribution-tracking map (stops retry attempts)

Peers that were offline when the delete was broadcast will not have the content in their store once they next request it (providers only fetch content in response to an explicit `CacheRequest` — they don't retain old copies across sessions unless they had already cached it).

---

## Supported Content Types

| Category | MIME types |
|---|---|
| Image | `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/svg+xml`, `image/avif` |
| Video | `video/mp4`, `video/webm`, `video/ogg` |
| Audio | `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/flac`, `audio/aac` |
| Document | `text/html`, `text/css`, `text/plain`, `text/markdown` |
| Code | `application/javascript`, `application/typescript` |
| Data | `application/json` |
| Binary | `application/octet-stream` (any file) |

Any MIME type works — NeuronChain stores raw bytes. The MIME type is recorded in the meta block and returned with the data at retrieval time.

---

## Transfers

### `send(fromPub, toIdentifier, amount, keys)`

Send UNIT from one account to another. `amount` is in milli-UNIT (use `parseUNIT()` to convert from a display string).

```typescript
import { parseUNIT } from './src/api/neuronchain-api';

const result = await api.send(
  fromPub,           // sender public key
  'alice',           // recipient username or public key
  parseUNIT('10'),   // 10 UNIT = 10_000 milli-UNIT
  keys,
);

if (result.block) console.log('Sent!', result.block.hash);
else console.error(result.error);
```

---

## Smart Contracts

Contracts run in an isolated Web Worker sandbox with no access to DOM, `fetch`, `localStorage`, `WebSocket`, or any other browser API. Execution timeout is 3 seconds. Contract calls on conflicted blocks are deferred until the conflict is resolved.

### `deployContract(name, code, fromPub, keys)`

Deploy a JavaScript contract. Returns the contract ID (block hash), which is permanent.

```typescript
const nftCode = `
  function init(name, symbol) {
    state.name = name;
    state.symbol = symbol;
    state.tokens = {};
    state.nextId = 1;
  }
  function mint(metadata, cid) {
    const id = state.nextId++;
    state.tokens[id] = { owner: caller, metadata, cid, mintedAt: Date.now() };
    return id;
  }
  function ownerOf(tokenId) { return state.tokens[tokenId]?.owner; }
  function myTokens() {
    return Object.entries(state.tokens)
      .filter(([, t]) => t.owner === caller)
      .map(([id]) => Number(id));
  }
`;

const { contractId, error } = await api.deployContract('MyNFT', nftCode, pub, keys);
if (contractId) console.log('Deployed:', contractId);
```

### `callContract(contractId, method, args, fromPub, keys)`

Call a contract method. Result is delivered asynchronously via the `contract:executed` event.

```typescript
// initialise the contract
await api.callContract(contractId!, 'init', ['My Collection', 'MYC'], pub, keys);

// mint an NFT with a content CID
await api.callContract(contractId!, 'mint', ['Rare Artwork #1', imageCid], pub, keys);

api.on('contract:executed', ({ contractId, method, result }) => {
  if (method === 'mint') console.log('NFT minted, token id:', result);
});
```

### `getContractState(contractId)`

Read contract state locally — no network round-trip.

```typescript
const state = api.getContractState(contractId!);
console.log(state?.tokens);
```

### `listContracts()`

List all contracts on the local ledger.

```typescript
const contracts = api.listContracts();
// [{ id, name, owner, deployedAt }]
```

---

## Decentralised Storage Ledger

Providers earn new UNIT minted directly into their account. No manual deals, no payments to chase.

**Earning rate formula:**
```
daily_rate = 1 UNIT × capacityGB × uptime_factor × latency_factor × spot_check_factor

uptime_factor     = heartbeat_blocks_today / 6         (max 1.0)
latency_factor    = 1000ms / avg_retrieval_latency_ms  (max 1.0)
spot_check_factor = spot_checks_passed / total_checks  (max 1.0)
```

All three on-chain proofs (register, heartbeat, reward) are verified by all peers before a block is accepted. Over-claiming is rejected by the ledger.

### `registerStorage(pub, capacityGB, keys)`

Register as a storage provider. Publishes a `storage-register` block on-chain. Heartbeat blocks (~every 4 hours with ±5 min jitter) and daily reward blocks are then issued automatically while the node is running.

```typescript
await api.registerStorage(myPub, 100, keys);  // offer 100 GB
```

### `deregisterStorage(pub, keys)`

Remove yourself from the storage ledger (sets `capacityGB = 0`).

```typescript
await api.deregisterStorage(myPub, keys);
```

### `getStorageProviders()`

List all active providers sorted by score descending.

```typescript
const providers = api.getStorageProviders();
for (const p of providers) {
  console.log(p.pub.slice(0, 12), p.capacityGB, 'GB  score:', p.score.toFixed(3));
}
```

`StorageProvider` fields:
```typescript
{
  pub: string;
  capacityGB: number;
  score: number;            // composite: uptime × latency × spot-check
  earningRate: number;      // projected milli-UNIT per day
  uptimePct: number;        // percentage based on today's heartbeat count
  avgLatencyMs: number;     // rolling 24h average (off-chain receipts)
  spotCheckPassRate: number;
  lastHeartbeat: number;    // Unix ms
  lastRewardEpoch: number;  // day index of last claimed reward
  deviceId?: string;        // prevents double-serving when same key on two machines
}
```

### `getStorageProvider(pub)`

Get a single provider's live profile. Returns `undefined` if not registered.

### `broadcastHeartbeat(pub, keys)`

Manually fire a heartbeat block (normally automatic every ~4 hours).

### `issueStorageReward()`

Manually claim today's storage reward if eligible (normally automatic once per day).

---

## Block Explorer

```typescript
api.getBlock(hash)            // AccountBlock | undefined
api.getChain(pub)             // AccountBlock[] — full account chain
api.getRecentBlocks(limit?)   // last N blocks across all accounts (default 50)
api.getLedgerStats()          // { totalAccounts, totalBlocks, ... }
```

---

## Account Helpers

```typescript
api.getBalance(pub)               // number (milli-UNIT)
api.getBalanceFormatted(pub)      // '1,000.000 UNIT'
api.getAccount(pub)               // Account | undefined
api.getAccountByUsername(name)    // Account | undefined
api.resolveAddress(identifier)    // public key string | undefined
                                  // accepts either a username or a public key
```

---

## Events

```typescript
// Ledger
api.on('block:added',             (block) => { });
api.on('block:confirmed',         (block) => { });
api.on('block:conflict',          ({ a, b }) => { });
api.on('block:rejected',          (block) => { });
api.on('account:synced',          (account) => { });
api.on('vote:received',           (vote) => { });

// Contracts
api.on('contract:deployed',       ({ contractId, name }) => { });
api.on('contract:executed',       ({ contractId, method, result }) => { });
api.on('contract:error',          ({ contractId, error }) => { });

// Storage ledger
api.on('storage:registered',      ({ pub, capacityGB }) => { });
api.on('storage:deregistered',    ({ pub }) => { });
api.on('storage:heartbeat-sent',  ({ pub }) => { });
api.on('storage:reward-issued',   ({ pub, amount, epochDay }) => { });
api.on('storage:cached',          ({ pub, cid }) => { });  // provider cached a block

// Messaging
api.on('inbox:signal',            (signal) => { });  // incoming transfer notification
api.on('auto:received',           (block) => { });   // receive block auto-claimed

// Network
api.on('peer:connected',          (peerId) => { });
api.on('peer:disconnected',       (peerId) => { });
api.on('node:started',            () => { });
api.on('node:stopped',            () => { });
api.on('resync',                  () => { });
```

---

## Types

### `ContentHandle`

Returned by `storeContent` and `storeContentPublic`.

```typescript
interface ContentHandle {
  cid: string;          // meta CID — use in block.contentCid or contract state
  contentCid?: string;  // inner content CID — pass alongside cid to distributeContent
  size: number;         // original byte length (before encryption for private content)
  mimeType: string;
  timestamp: number;    // Unix ms
}
```

### `StorageProvider`

```typescript
interface StorageProvider {
  pub: string;
  capacityGB: number;
  score: number;
  earningRate: number;
  uptimePct: number;
  avgLatencyMs: number;
  spotCheckPassRate: number;
  lastHeartbeat: number;
  lastRewardEpoch: number;
  deviceId?: string;
}
```

---

## Full Example: Decentralised Media Gallery

A complete example showing private upload, distribution, retrieval, NFT minting, public posts, and deletion.

```typescript
import { NeuronChainAPI, parseUNIT } from './src/api/neuronchain-api';

const api = new NeuronChainAPI('mainnet');
await api.start();
api.registerKey(myPub, myKeys);

// ── Upload a private photo ─────────────────────────────────────────────────

async function uploadPhoto(file: File): Promise<{ cid: string; contentCid?: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Store encrypted — only you can decrypt
  const handle = await api.storeContent(bytes, file.type, myKeys, file.name);

  // Replicate to storage providers — pass both CIDs
  const cids = [handle.cid, handle.contentCid].filter(Boolean) as string[];
  const { providers, error } = await api.distributeContent(cids, myPub, myKeys);
  if (error) console.warn('No providers yet:', error);
  else console.log(`Replicated to ${providers.length} node(s)`);

  // Mint as an NFT so it's discoverable on-chain
  await api.callContract(galleryContractId, 'mint', [file.name, handle.cid], myPub, myKeys);

  return { cid: handle.cid, contentCid: handle.contentCid };
}

// ── Retrieve a photo ───────────────────────────────────────────────────────

async function loadPhoto(cid: string): Promise<string> {
  // Auto-detect: tries decryption first, then public
  const result = await api.retrieveContentAuto(cid, myKeys);
  if (!result) throw new Error('Not found: ' + cid);

  const blob = new Blob([result.data], { type: result.mimeType });
  return URL.createObjectURL(blob);  // use as <img src>
}

// ── Delete a photo ─────────────────────────────────────────────────────────

async function deletePhoto(cid: string, contentCid?: string): Promise<void> {
  const cids = [cid, contentCid].filter(Boolean) as string[];
  await api.deleteContent(cids, myPub, myKeys);
  // Local copy gone immediately. Connected providers drop their copies via GossipSub.
}

// ── Share a public post ────────────────────────────────────────────────────

async function publishPost(title: string, body: string): Promise<string> {
  const payload = JSON.stringify({ title, body, author: myPub, ts: Date.now() });
  const handle = await api.storeContentPublic(
    new TextEncoder().encode(payload),
    'application/json',
    title,
  );
  const cids = [handle.cid, handle.contentCid].filter(Boolean) as string[];
  await api.distributeContent(cids, myPub, myKeys);
  return handle.cid;
}

async function readPost(cid: string) {
  const bytes = await api.retrieveContentPublic(cid);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ── Listen for events ──────────────────────────────────────────────────────

api.on('storage:cached', ({ cid }) => {
  console.log('A provider cached:', cid.slice(0, 20));
});

api.on('storage:reward-issued', ({ pub, amount }) => {
  console.log(`Provider ${pub.slice(0, 12)} earned ${amount} milli-UNIT`);
});

api.on('contract:executed', ({ method, result }) => {
  if (method === 'mint') console.log('NFT minted, token id:', result);
});
```

---

## Relay Server

The relay server (`relay-server.js`) serves four roles:

| Role | Port | Path | Purpose |
|---|---|---|---|
| libp2p relay | 9090 | `/` | Circuit relay v2, bootstrap, GossipSub routing |
| HTTP info | 9092 | `/` | Node stats, health check |
| Smoke hub | 9092 | `/smoke-hub` | WebSocket signaling for smoke WebRTC peer discovery |

The smoke hub is a simple address registry: each node connects, registers its UUID Hub address, and the hub routes WebRTC ICE/offer/answer messages between peers by address. Once ICE negotiation completes, all block transfer happens peer-to-peer over the WebRTC data channel — the relay is not on the data path.

To run the relay independently:

```bash
node relay-server.js              # port 9090 (libp2p) + 9092 (HTTP + smoke hub)
PORT=443 node relay-server.js     # custom port
```

For multi-device testing over HTTPS/WSS:

```bash
npm run tunnel   # cloudflare tunnel pointing at the local relay
```
