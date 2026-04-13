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

// Register local key (obtained from account creation)
api.registerKey(pub, keys);

// Transfer UNIT
await api.send(fromPub, 'alice', 100_000, keys);

// Store encrypted content - returns CID
const handle = await api.storeContent(imageBytes, 'image/jpeg', keys, 'my-photo');

// Retrieve and decrypt
const bytes = await api.retrieveContent(handle.cid, keys);

// Deploy contract
const { contractId } = await api.deployContract('MyNFT', nftCode, pub, keys);

// Call contract
await api.callContract(contractId, 'mint', ['My Artwork', handle.cid], pub, keys);

// Serve storage (earn UNIT automatically)
await api.registerStorage(pub, 100, keys); // offer 100 GB

// Distribute content to 10 providers after storing
const { providers } = await api.distributeContent(imageCid, pub, keys);

// Events
api.on('block:confirmed',        (block) => console.log('Confirmed!', block));
api.on('storage:reward-issued',  ({ amount }) => console.log('Reward minted:', amount, 'milli-UNIT'));
```

---

## Content Storage

Content has **dynamic visibility** - each piece of content is stored with an explicit visibility mode:

| Visibility | Storage method | Who can read |
|---|---|---|
| **Public** | `storeWithMetaPublic()` - raw bytes, no encryption | Anyone with the CID |
| **Private** | `storeWithMeta()` - AES-256-GCM encrypted | Only the key holder |

All store actions are **ECDSA P-256 signed** by the account key regardless of visibility - the signature is carried in the on-chain block that references the CID. This means even public content is authentically attributed.

The CID returned is content-addressed (SHA-256) - tamper-evident by construction. Retrieval auto-detects visibility: tries decryption first, falls back to public.

### Supported Content Types

| Content Type | MIME Type | Description |
|---|---|---|
| JSON | `application/json` | Any structured data - posts, comments, profiles, config, etc. |
| Image | `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/svg+xml`, `image/avif` | Photos, graphics |
| Video | `video/mp4`, `video/webm`, `video/ogg` | Short clips, full videos |
| Audio | `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/flac`, `audio/aac` | Music, podcasts, voice notes |
| HTML | `text/html` | Web pages, dApp frontends |
| CSS | `text/css` | Stylesheets |
| JavaScript | `application/javascript` | Scripts, dApp code |
| JSON | `application/json` | Structured data, configuration |
| Other | `application/octet-stream` | Any binary file |

### `storeContent(data, mimeType, keys, name?)` - private

Encrypt with AES-256-GCM and store. Only the key holder can decrypt.

```typescript
// Private - only you can read
const handle = await api.storeContent(
  imageBytes,       // Uint8Array
  'image/jpeg',     // MIME type
  keys,             // KeyPair (ECDSA + ECDH)
  'my-photo.jpg',   // optional name label
);

console.log(handle.cid);       // IPFS CID - store in blocks or contracts
console.log(handle.size);      // bytes before encryption
console.log(handle.mimeType);  // 'image/jpeg'
console.log(handle.timestamp); // Unix ms
```

### `node.helia.storeWithMetaPublic(data, meta)` - public

Store without encryption. Anyone with the CID can read. Signed on-chain via the block referencing it.

```typescript
// Public - anyone can read
const { cid } = await node.helia.storeWithMetaPublic(postBytes, {
  mimeType: 'application/json',
  name: 'My Post',
});
```

### `retrieveContent(cid, keys)`

Retrieve and decrypt private content by CID. Throws if decryption fails.

```typescript
const bytes = await api.retrieveContent(handle.cid, keys);
// Reconstruct: new Blob([bytes], { type: 'image/jpeg' })
```

### `node.helia.retrieveAuto(cid, keys?)`

Auto-detect visibility and retrieve. Tries encrypted first (if keys provided), falls back to public. Returns `{ data, meta, wasEncrypted }`.

```typescript
const result = await node.helia.retrieveAuto(cid, keys);
if (result) {
  console.log(result.wasEncrypted); // true = private, false = public
  console.log(result.meta.mimeType);
}
```

### `storeJSON(data, keys)`

Store a JSON object (encrypted). Returns CID string.

```typescript
const post = { title: 'Hello World', body: '...', tags: ['web3'], timestamp: Date.now() };
const cid = await api.storeJSON(post, keys);
```

### `retrieveJSON<T>(cid, keys)`

Retrieve and parse a JSON object.

```typescript
const post = await api.retrieveJSON<{ title: string; body: string }>(cid, keys);
```

### `storeText(text, keys)`

Store plain text (HTML, CSS, JS, markdown) encrypted.

```typescript
const cid = await api.storeText('<html><body>My dApp</body></html>', keys);
```

### `retrieveText(cid, keys)`

Retrieve and decode text content.

```typescript
const html = await api.retrieveText(cid, keys);
```

---

## Transfers

### `send(fromPub, toIdentifier, amount, keys)`

Send UNIT from one account to another. `amount` is in milli-UNIT.

```typescript
import { parseUNIT } from './src/api/neuronchain-api';

const result = await api.send(
  fromPub,          // sender public key
  'alice',          // recipient username or public key
  parseUNIT('10'),  // 10 UNIT = 10_000 milli-UNIT
  keys,
);

if (result.block) console.log('Sent!', result.block.hash);
else console.error(result.error);
```

---

## Smart Contracts

### `deployContract(name, code, fromPub, keys)`

Deploy a JavaScript contract. Returns the contract ID (block hash).

```typescript
const { contractId, error } = await api.deployContract('MyNFT', nftCode, pub, keys);
```

### `callContract(contractId, method, args, fromPub, keys)`

Call a contract method.

```typescript
await api.callContract(contractId, 'mint', ['My Artwork', imageCid], pub, keys);
```

### `getContractState(contractId)`

Read contract state locally (no network round-trip).

```typescript
const state = api.getContractState(contractId);
console.log(state?.balances);
```

### `listContracts()`

List all contracts on the local ledger.

```typescript
const contracts = api.listContracts();
// [{ id, name, owner, deployedAt }]
```

---

## Decentralised Storage Ledger

NeuronChain has an automated storage incentive system. Providers earn new UNIT minted directly into their account - no manual deals, no payments to chase.

**Earning rate:**
```
daily_rate = 1 UNIT × capacityGB × uptime_factor × latency_factor × spot_check_factor
```

### `registerStorage(pub, capacityGB, keys)`

Register as a storage provider. Publishes a `storage-register` block on-chain. Heartbeats and daily rewards are then issued automatically by `StorageManager` while the node is running.

```typescript
await api.registerStorage(myPub, 100, keys); // offer 100 GB
```

### `deregisterStorage(pub, keys)`

Remove yourself from the storage ledger (sets capacityGB = 0).

```typescript
await api.deregisterStorage(myPub, keys);
```

### `getStorageProviders()`

List all active providers sorted by score descending.

```typescript
const providers = api.getStorageProviders();
// StorageProvider: { pub, capacityGB, score, earningRate, uptimePct, avgLatencyMs, ... }
```

### `getStorageProvider(pub)`

Get a specific provider's live profile.

### `distributeContent(cid, uploaderPub, keys)`

Distribute a stored CID to up to 10 providers selected by weighted-random algorithm. Providers fetch via Helia/Bitswap and pin locally.

```typescript
const { providers } = await api.distributeContent(imageCid, myPub, keys);
console.log(`Distributed to ${providers.length} nodes`);
```

### `broadcastHeartbeat(pub, keys)`

Manually send a heartbeat block (normally fires automatically every ~4h).

### `issueStorageReward()`

Manually trigger today's reward claim (normally fires automatically once per day).

---

## Block Explorer

```typescript
api.getBlock(hash)                // AccountBlock | undefined
api.getChain(pub)                 // AccountBlock[] - full account chain
api.getRecentBlocks(limit?)       // last N blocks across all accounts
api.getLedgerStats()              // { totalAccounts, totalBlocks, ... }
```

---

## Account Helpers

```typescript
api.getBalance(pub)               // number (milli-UNIT)
api.getBalanceFormatted(pub)      // string (e.g. "1,000.000 UNIT")
api.getAccount(pub)               // Account | undefined
api.getAccountByUsername(name)    // Account | undefined
api.resolveAddress(identifier)    // pub key string | undefined
```

---

## Events

Subscribe to ledger and network events:

```typescript
api.on('block:confirmed',          (block) => { });
api.on('block:conflict',           ({ a, b }) => { });
api.on('block:rejected',           (block) => { });
api.on('account:synced',           (account) => { });
api.on('contract:deployed',        ({ contractId, name }) => { });
api.on('contract:executed',        ({ contractId, method, result }) => { });
api.on('contract:error',           ({ contractId, error }) => { });
api.on('storage:registered',       ({ pub, capacityGB }) => { });
api.on('storage:deregistered',     ({ pub }) => { });
api.on('storage:heartbeat-sent',   ({ pub }) => { });
api.on('storage:reward-issued',    ({ pub, amount, epochDay }) => { });
api.on('storage:pinned',           ({ pub, cid }) => { });
api.on('inbox:signal',             (signal) => { });
api.on('auto:received',            (block) => { });
api.on('peer:connected',           (peerId) => { });
api.on('peer:disconnected',        (peerId) => { });
api.on('node:started',             () => { });
api.on('node:stopped',             () => { });
```

---

## ContentHandle

```typescript
interface ContentHandle {
  cid: string;       // IPFS CID - use in block.contentCid or contract state
  size: number;      // bytes before encryption
  mimeType: string;
  timestamp: number; // Unix ms
}
```

---

## Full dApp Example: Decentralised Blog

```typescript
import { NeuronChainAPI, parseUNIT } from './src/api/neuronchain-api';

const api = new NeuronChainAPI('mainnet');
await api.start();
api.registerKey(myPub, myKeys);

// Publish a post
async function publishPost(title: string, body: string, tags: string[]) {
  const payload = JSON.stringify({ type: 'post', title, body, tags, timestamp: Date.now() });
  const cid = await api.storeText(payload, myKeys);
  // Anchor on-chain by sending 0 to yourself with contentCid
  // (or store cid in a contract's state for discoverability)
  return cid;
}

// Publish an image post
async function publishImage(imageBytes: Uint8Array, caption: string) {
  const handle = await api.storeContent(imageBytes, 'image/jpeg', myKeys, caption);
  return handle.cid;
}

// Retrieve and display a post
async function fetchPost(cid: string) {
  const text = await api.retrieveText(cid, myKeys);
  return text ? JSON.parse(text) : null;
}
```
