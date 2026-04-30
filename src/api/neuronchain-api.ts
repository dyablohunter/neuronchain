/**
 * NeuronChain dApp API
 *
 * A clean, stable facade for building decentralised applications on NeuronChain.
 * Import this in your dApp instead of accessing NeuronNode internals directly.
 *
 * Quick start:
 *
 *   import { NeuronChainAPI } from './api/neuronchain-api';
 *
 *   const api = new NeuronChainAPI('testnet');
 *   await api.start();
 *
 *   // Transfers
 *   const block = await api.send(fromPub, toPub, 100_000, keys);
 *
 *   // Store encrypted content (returns CID)
 *   const cid = await api.storeContent(imageBytes, 'image/jpeg', keys);
 *
 *   // Retrieve content
 *   const bytes = await api.retrieveContent(cid, keys);
 *
 *   // Deploy NFT contract
 *   const contractId = await api.deployContract('MyNFT', nftCode, keys);
 *
 *   // Mint NFT
 *   await api.callContract(contractId, 'mint', ['token metadata', cid], keys);
 *
 *   // Listen for events
 *   api.on('block:confirmed', (block) => console.log('Confirmed!', block));
 */

import { NeuronNode } from '../network/node';
import { AccountBlock, formatUNIT, parseUNIT } from '../core/dag-block';
import { KeyPair } from '../core/crypto';
import { NetworkType, StorageProvider } from '../core/dag-ledger';
import { EventEmitter } from '../core/events';

export { formatUNIT, parseUNIT };

export interface ContentHandle {
  /** Meta CID (SHA-256) - store in block.contentCid or contract state */
  cid: string;
  /** Inner content CID - pass alongside cid to distributeContent so providers cache both blocks */
  contentCid?: string;
  /** Original byte length before encryption */
  size: number;
  mimeType: string;
  timestamp: number;
}

export type { StorageProvider };

export class NeuronChainAPI extends EventEmitter {
  private node: NeuronNode;

  constructor(network: NetworkType = 'testnet') {
    super();
    this.node = new NeuronNode(network);
    // Forward all node events
    const events = [
      'block:added', 'block:confirmed', 'block:conflict', 'block:rejected',
      'account:synced', 'vote:received', 'peer:connected', 'peer:disconnected',
      'contract:deployed', 'contract:executed', 'contract:error',
      'inbox:signal', 'auto:received', 'resync',
      'storage:registered', 'storage:deregistered', 'storage:heartbeat-sent',
      'storage:reward-issued', 'storage:cached', 'storage:deleted', 'storage:replaced',
      'node:started', 'node:stopped',
    ];
    for (const ev of events) {
      this.node.on(ev, (...args: unknown[]) => this.emit(ev, ...args));
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> { await this.node.start(); }
  async stop(): Promise<void>  { await this.node.stop(); }

  getStats() { return this.node.getStats(); }
  get network(): NetworkType { return this.node.ledger.network; }

  // ── Keys ──────────────────────────────────────────────────────────────────

  /** Register a local key so the node can auto-receive and auto-vote */
  registerKey(pub: string, keys: KeyPair): void {
    this.node.addLocalKey(pub, keys);
  }

  // ── Accounts ─────────────────────────────────────────────────────────────

  getBalance(pub: string): number { return this.node.ledger.getAccountBalance(pub); }
  getBalanceFormatted(pub: string): string { return formatUNIT(this.getBalance(pub)); }

  getAccount(pub: string) { return this.node.ledger.getAccountByPub(pub); }
  getAccountByUsername(username: string) { return this.node.ledger.getAccountByUsername(username); }
  resolveAddress(identifier: string): string | undefined { return this.node.ledger.resolveToPublicKey(identifier); }

  // ── Transfers ─────────────────────────────────────────────────────────────

  /**
   * Send UNIT from one account to another.
   * `amount` is in milli-UNIT (use parseUNIT() to convert from display string).
   */
  async send(
    fromPub: string,
    toIdentifier: string,
    amount: number,
    keys: KeyPair,
  ): Promise<{ block?: AccountBlock; error?: string }> {
    const result = await this.node.ledger.createSend(fromPub, toIdentifier, amount, keys);
    if (!result.block) return result;
    const submitResult = await this.node.submitBlock(result.block);
    if (!submitResult.success) return { error: submitResult.error };
    return { block: result.block };
  }

  // ── Content storage (smoke - IndexedDB + HTTP-over-WebRTC) ───────────────

  /**
   * Store encrypted content. Returns a ContentHandle with the CID.
   * Use handle.cid as block.contentCid or in NFT contract state.
   *
   * Supported types: any binary data - images, video, audio, HTML, CSS, JS, JSON, text.
   * All content is encrypted with the account's content key before storing.
   */
  async storeContent(
    data: Uint8Array,
    mimeType: string,
    keys: KeyPair,
    name?: string,
  ): Promise<ContentHandle> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    const result = await this.node.store.storeWithMeta(data, { mimeType, name }, keys);
    return { cid: result.cid, contentCid: result.meta.contentCid, size: data.length, mimeType, timestamp: result.meta.timestamp };
  }

  /** Retrieve and decrypt private content by CID. Throws if decryption fails. */
  async retrieveContent(cid: string, keys: KeyPair): Promise<Uint8Array> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    const result = await this.node.store.retrieveWithMeta(cid, keys);
    if (!result) throw new Error(`Content not found or decryption failed: ${cid}`);
    return result.data;
  }

  /**
   * Store public (unencrypted) content. Returns a ContentHandle with the CID.
   * Anyone with the CID can retrieve this content without keys.
   */
  async storeContentPublic(
    data: Uint8Array,
    mimeType: string,
    name?: string,
  ): Promise<ContentHandle> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    const result = await this.node.store.storeWithMetaPublic(data, { mimeType, name });
    return { cid: result.cid, contentCid: result.meta.contentCid, size: data.length, mimeType, timestamp: result.meta.timestamp };
  }

  /**
   * Retrieve public (unencrypted) content by CID.
   * Use this when the content was stored with `storeContentPublic`.
   */
  async retrieveContentPublic(cid: string): Promise<Uint8Array> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    const result = await this.node.store.retrieveWithMetaPublic(cid);
    if (!result) throw new Error(`Content not found: ${cid}`);
    return result.data;
  }

  /**
   * Retrieve content by CID without knowing whether it was stored as public or private.
   * Tries decryption first (if keys provided), then falls back to public read.
   * Returns the data, metadata, and whether it was encrypted.
   */
  async retrieveContentAuto(
    cid: string,
    keys?: KeyPair,
  ): Promise<{ data: Uint8Array; mimeType: string; size: number; wasEncrypted: boolean } | undefined> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    const result = await this.node.store.retrieveAuto(cid, keys);
    if (!result) return undefined;
    return {
      data: result.data,
      mimeType: result.meta.mimeType,
      size: result.meta.size,
      wasEncrypted: result.wasEncrypted,
    };
  }

  /**
   * Delete content locally and broadcast a signed delete request to all caching providers.
   * Providers verify the owner's signature before dropping their copies.
   * Pass all CIDs related to the content - the meta CID and the inner content CID if known.
   */
  async deleteContent(cids: string[], ownerPub: string, keys: KeyPair): Promise<void> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    return this.node.deleteContent(cids, ownerPub, keys);
  }

  /**
   * Replace content across the network with new data. The old CIDs are deleted locally
   * and a signed ReplaceRequest is broadcast via GossipSub so every provider holding the
   * old content drops it and caches the new version. The new content is also distributed
   * to up to 10 providers via the normal CacheRequest path.
   *
   * Storage rewards automatically reflect the change: the next heartbeat block each
   * provider sends includes updated `actualStoredBytes`, which feeds into reward calculation.
   *
   * Typical usage:
   *   const newHandle = await api.storeContent(newData, mimeType, keys);
   *   await api.replaceContent(
   *     [oldHandle.cid, oldHandle.contentCid].filter(Boolean) as string[],
   *     [newHandle.cid, newHandle.contentCid].filter(Boolean) as string[],
   *     myPub, keys,
   *   );
   */
  async replaceContent(
    oldCids: string[],
    newCids: string[],
    ownerPub: string,
    keys: KeyPair,
  ): Promise<{ providers: string[]; error?: string }> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    return this.node.replaceContent(oldCids, newCids, ownerPub, keys);
  }

  /** Store a JSON object encrypted. Returns CID. */
  async storeJSON(data: unknown, keys: KeyPair): Promise<string> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    return this.node.store.storeJSON(data, keys);
  }

  /** Retrieve and decrypt a JSON object. */
  async retrieveJSON<T>(cid: string, keys: KeyPair): Promise<T | undefined> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    return this.node.store.retrieveJSON<T>(cid, keys);
  }

  /** Store raw text (HTML, CSS, JS, markdown) encrypted. Returns CID. */
  async storeText(text: string, keys: KeyPair): Promise<string> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    return this.node.store.storeText(text, keys);
  }

  async retrieveText(cid: string, keys: KeyPair): Promise<string | undefined> {
    if (!this.node.store.isStarted()) throw new Error('Node not started');
    return this.node.store.retrieveText(cid, keys);
  }

  // ── Smart Contracts ───────────────────────────────────────────────────────

  /**
   * Deploy a smart contract. Returns the contract ID (block hash).
   * The contract ID is permanent - use it for all future calls.
   */
  async deployContract(name: string, code: string, fromPub: string, keys: KeyPair): Promise<{ contractId?: string; error?: string }> {
    const result = await this.node.ledger.createDeploy(fromPub, name, code, keys);
    if (!result.block) return { error: result.error };
    const submitResult = await this.node.submitBlock(result.block);
    if (!submitResult.success) return { error: submitResult.error };
    return { contractId: result.block.hash };
  }

  /**
   * Call a contract method. Result is delivered asynchronously via the
   * 'contract:executed' event (fire-and-forget from the chain's perspective).
   */
  async callContract(
    contractId: string,
    method: string,
    args: unknown[],
    fromPub: string,
    keys: KeyPair,
  ): Promise<{ block?: AccountBlock; error?: string }> {
    const result = await this.node.ledger.createCall(fromPub, contractId, method, args, keys);
    if (!result.block) return { error: result.error };
    const submitResult = await this.node.submitBlock(result.block);
    if (!submitResult.success) return { error: submitResult.error };
    return { block: result.block };
  }

  /** Get current contract state (read-only, local) */
  getContractState(contractId: string): Record<string, unknown> | undefined {
    return this.node.ledger.contracts.get(contractId)?.state;
  }

  listContracts(): { id: string; name: string; owner: string; deployedAt: number }[] {
    return Array.from(this.node.ledger.contracts.entries()).map(([id, c]) => ({
      id, name: c.name, owner: c.owner, deployedAt: c.deployedAt,
    }));
  }

  // ── Decentralised storage ledger ──────────────────────────────────────────

  /**
   * Register as a storage provider.
   * Publishes a storage-register block on-chain. Heartbeats and daily rewards
   * are then managed automatically by StorageManager while the node is running.
   */
  async registerStorage(pub: string, capacityGB: number, keys: KeyPair): Promise<{ success: boolean; error?: string }> {
    return this.node.registerStorage(pub, capacityGB, keys);
  }

  /** Deregister from the storage ledger (sets capacityGB = 0). */
  async deregisterStorage(pub: string, keys: KeyPair): Promise<{ success: boolean; error?: string }> {
    return this.node.deregisterStorage(pub, keys);
  }

  /** Get all active storage providers sorted by score (highest first). */
  getStorageProviders(): StorageProvider[] {
    return this.node.ledger.getStorageProviders();
  }

  /** Get a specific provider's live profile (undefined if not registered). */
  getStorageProvider(pub: string): StorageProvider | undefined {
    return this.node.ledger.storageProviders.get(pub);
  }

  /**
   * Distribute stored CIDs to up to 10 network providers.
   * Always pass both the meta CID and the inner contentCid so providers pin both blocks.
   * Providers fetch the content via smoke Http (HTTP over WebRTC) and pin it locally.
   * Returns the list of selected provider pub keys.
   */
  async distributeContent(cids: string | string[], uploaderPub: string, keys: KeyPair): Promise<{ providers: string[]; error?: string }> {
    return this.node.distributeContent(cids, uploaderPub, keys);
  }

  /** Manually trigger a heartbeat for a local provider account (normally automatic). */
  async broadcastHeartbeat(pub: string, keys: KeyPair): Promise<{ success: boolean; error?: string }> {
    return this.node.storage.broadcastHeartbeat(pub, keys);
  }

  /** Manually trigger today's storage reward if eligible (normally automatic). */
  async issueStorageReward(): Promise<void> {
    return this.node.storage.issueRewardsIfEligible();
  }

  // ── Block explorer ────────────────────────────────────────────────────────

  getBlock(hash: string): AccountBlock | undefined { return this.node.ledger.getBlock(hash); }
  getChain(pub: string): AccountBlock[] { return this.node.ledger.getAccountChain(pub); }
  getRecentBlocks(limit = 50): AccountBlock[] { return this.node.ledger.getAllBlocks().slice(0, limit); }
  getLedgerStats() { return this.node.ledger.getStats(); }
}
