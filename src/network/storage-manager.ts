/**
 * Decentralised Storage Manager
 *
 * Manages the lifecycle of NeuronChain's built-in storage ledger:
 *
 *   Providers register with a capacity (GB) via a storage-register block.
 *   Every ~4 hours, active providers broadcast a storage-heartbeat block (proof of uptime).
 *   Once per day, providers self-issue a storage-reward block that mints new UNIT:
 *     reward = BASE_RATE × capacityGB × (heartbeatCount / MAX_HEARTBEATS_PER_DAY)
 *
 *   When a user stores content, StorageManager selects up to 10 providers from
 *   the ledger (weighted random by capacityGB × score), publishes a cache request,
 *   and those providers fetch and cache the CID via smoke Http (HTTP over WebRTC).
 *
 *   Off-chain retrieval receipts (signed by the requesting peer) are collected
 *   and used to update latency and spot-check metrics in the provider's ledger
 *   profile. These affect the displayed score but not on-chain reward validation.
 */

import { EventEmitter } from '../core/events';
import { DAGLedger, StorageProvider } from '../core/dag-ledger';
import { Libp2pNetwork } from './libp2p-network';
import { SmokeStore } from './smoke-store';
import { AccountBlock, HEARTBEAT_INTERVAL_MS, REWARD_EPOCH_MS } from '../core/dag-block';
import { KeyPair, signData, verifySignature } from '../core/crypto';
import { getDeviceId } from './node';

const HEARTBEAT_JITTER_MS = 5 * 60 * 1000;          // ±5 min jitter so nodes don't all fire at once
const REWARD_CHECK_INTERVAL_MS = 30 * 60 * 1000;    // check every 30 min whether today's reward is due
const SPOT_CHECK_INTERVAL_MS   = 60 * 60 * 1000;    // run spot checks every hour
const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000;      // keep receipts for 24h rolling window
const REDUNDANCY_TARGET = 10;                        // target copies per file

export interface StorageReceipt {
  [key: string]: unknown;
  /** Provider that served the content */
  providerPub: string;
  /** Peer that retrieved and signed the receipt */
  requesterPub: string;
  cid: string;
  latencyMs: number;
  success: boolean;
  timestamp: number;
  /** ECDSA signature by requesterPub over canonical payload */
  signature: string;
  /** Smoke Hub address of the provider - other nodes use this for Http.fetch fallback */
  providerSmokeAddr?: string;
  /** 1-indexed response rank among all providers checked in this spot-check round (1 = fastest) */
  responseRank?: number;
  /** Total number of providers checked in this spot-check round */
  totalProviders?: number;
}

export interface CacheRequest {
  [key: string]: unknown;
  cid: string;
  /** Additional CIDs that must also be cached (e.g. contentCid inside a meta envelope) */
  additionalCids?: string[];
  /** Public keys of providers selected to cache this CID */
  targetProviders: string[];
  uploaderPub: string;
  /** Smoke Hub address of the uploader - providers use Http.fetch to pull blocks via WebRTC */
  uploaderSmokeAddr?: string;
  timestamp: number;
  signature: string;
}

export interface DeleteRequest {
  /** All CIDs to delete (meta + content) */
  cids: string[];
  ownerPub: string;
  timestamp: number;
  /** ECDSA signature by ownerPub over `delete:<cids.join(',')>:<ownerPub>:<timestamp>` */
  signature: string;
}

export interface ReplaceRequest {
  [key: string]: unknown;
  /** Primary old CID being replaced */
  oldCid: string;
  /** Additional old CIDs to drop (e.g. old inner contentCid) */
  oldAdditionalCids?: string[];
  /** New primary CID to cache */
  newCid: string;
  /** Additional new CIDs to cache (e.g. new inner contentCid) */
  newAdditionalCids?: string[];
  ownerPub: string;
  /** Smoke Hub address of the owner - providers use this to fetch new blocks via WebRTC */
  uploaderSmokeAddr?: string;
  timestamp: number;
  /** ECDSA signature by ownerPub over `replace:<oldCid>:<newCid>:<ownerPub>:<timestamp>` */
  signature: string;
}

export class StorageManager extends EventEmitter {
  private ledger: DAGLedger;
  private net: Libp2pNetwork;
  private store: SmokeStore;
  private localKeys: Map<string, KeyPair>;

  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private rewardInterval: ReturnType<typeof setInterval> | null = null;
  private spotCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** Rolling 24h receipts per provider (off-chain, in-memory only) */
  private receipts: Map<string, StorageReceipt[]> = new Map();

  /** CIDs we're tracking for redundancy: cid → { owner, confirmedProviders, additionalCids, lastDistributed } */
  private trackedCids: Map<string, { ownerPub: string; confirmedProviders: Set<string>; additionalCids: string[]; lastDistributed: number }> = new Map();

  /** Known providers for each CID (from receipts) - used for targeted retrieval */
  private cidToSmokeAddrs: Map<string, Set<string>> = new Map();

  /** CIDs that failed distribution (no providers at upload time): primaryCid → { ownerPub, additionalCids } */
  private pendingCids: Map<string, { ownerPub: string; additionalCids: string[] }> = new Map();

  private started = false;

  constructor(
    ledger: DAGLedger,
    net: Libp2pNetwork,
    store: SmokeStore,
    localKeys: Map<string, KeyPair>,
  ) {
    super();
    this.ledger = ledger;
    this.net = net;
    this.store = store;
    this.localKeys = localKeys;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // P7: load persisted trackedCids from IDB so redundancy checks survive restarts
    const persisted = await this.net.loadTrackedCids();
    for (const rec of persisted) {
      this.trackedCids.set(rec.cid, {
        ownerPub: rec.ownerPub,
        confirmedProviders: new Set(rec.confirmedProviders),
        additionalCids: rec.additionalCids,
        lastDistributed: rec.lastDistributed,
      });
    }

    // Watch for incoming cache requests from other nodes.
    // Every node - not just providers - registers the uploader's smoke address so
    // retrieve() can fetch directly from the uploader via WebRTC if needed.
    this.net.watchCacheRequests(async (req) => {
      const r = req as unknown as CacheRequest;
      if (r.uploaderSmokeAddr) this.store.addPeerFallback(r.uploaderSmokeAddr);
      await this.handleCacheRequest(r);
    });

    // Watch for retrieval receipts from peers
    this.net.watchStorageReceipts((receipt) => this.handleReceipt(receipt as unknown as StorageReceipt));

    // Watch for content delete requests - any node that holds the blocks drops them
    this.net.watchDeleteRequests(async (req) => {
      await this.handleDeleteRequest(req as unknown as DeleteRequest);
    });

    // Watch for content replace requests - providers holding old content swap to the new version
    this.net.watchReplaceRequests(async (req) => {
      await this.handleReplaceRequest(req as unknown as ReplaceRequest);
    });

    // Retry pending CIDs whenever a new provider registers (covers the case where
    // files were uploaded before any provider was available).
    this.ledger.on('storage:registered', () => {
      setTimeout(() => this.retryPendingDistributions(), 2_000);
    });

    // Retry all unconfirmed distributions every 30s. Covers the case where the
    // GossipSub mesh wasn't fully formed when the cache request was first published
    // (fire-and-forget messages are lost if no peers were in the mesh at that moment).
    setInterval(() => this.retryUnconfirmedDistributions(), 30_000);

    // Schedule the first heartbeat with jitter, then repeat
    this.scheduleNextHeartbeat();

    // Check daily reward eligibility every 30 min
    this.rewardInterval = setInterval(() => this.issueRewardsIfEligible(), REWARD_CHECK_INTERVAL_MS);
    // Also check immediately on start (catches missed day-boundary events)
    setTimeout(() => this.issueRewardsIfEligible(), 5_000);

    // Run spot checks hourly
    this.spotCheckInterval = setInterval(() => this.runSpotChecks(), SPOT_CHECK_INTERVAL_MS);

    console.log('[StorageManager] Started');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.rewardInterval) { clearInterval(this.rewardInterval); this.rewardInterval = null; }
    if (this.spotCheckInterval) { clearInterval(this.spotCheckInterval); this.spotCheckInterval = null; }
    console.log('[StorageManager] Stopped');
  }

  // ── Heartbeats ────────────────────────────────────────────────────────────

  private scheduleNextHeartbeat(): void {
    if (!this.started) return;
    const jitter = Math.random() * HEARTBEAT_JITTER_MS;
    const delay = HEARTBEAT_INTERVAL_MS + jitter;
    this.heartbeatTimer = setTimeout(async () => {
      await this.broadcastHeartbeatsForAll();
      this.scheduleNextHeartbeat();
    }, delay);
  }

  private async broadcastHeartbeatsForAll(): Promise<void> {
    const localDeviceId = getDeviceId();
    for (const [pub, keys] of this.localKeys) {
      const provider = this.ledger.storageProviders.get(pub);
      if (!provider || provider.capacityGB === 0) continue;
      if (provider.deviceId && localDeviceId && provider.deviceId !== localDeviceId) continue;
      await this.broadcastHeartbeat(pub, keys);
    }
  }

  async broadcastHeartbeat(pub: string, keys: KeyPair): Promise<{ success: boolean; error?: string }> {
    const smokeAddr = await this.store.getSmokeHostname();
    const actualStoredBytes = this.store.isStarted() ? await this.store.storageUsedBytes() : 0;
    const result = await this.ledger.createStorageHeartbeat(pub, keys, smokeAddr, actualStoredBytes);
    if (!result.block) return { success: false, error: result.error };
    const submitResult = await this.submitBlock(result.block);
    if (submitResult.success) {
      console.log(`[StorageManager] Heartbeat broadcast for ${pub.slice(0, 12)}...`);
      this.emit('storage:heartbeat-sent', { pub });
    }
    return submitResult;
  }

  // ── Daily rewards ─────────────────────────────────────────────────────────

  async issueRewardsIfEligible(): Promise<void> {
    for (const [pub, keys] of this.localKeys) {
      const provider = this.ledger.storageProviders.get(pub);
      if (!provider || provider.capacityGB === 0) continue;
      const epochDay = Math.floor(Date.now() / REWARD_EPOCH_MS);
      if (provider.lastRewardEpoch >= epochDay) continue;

      const result = await this.ledger.createStorageReward(pub, keys);
      if (!result.block) {
        // Not yet eligible (no heartbeats today, or already claimed) - log and continue
        continue;
      }
      const submitResult = await this.submitBlock(result.block);
      if (submitResult.success) {
        try {
          const data = JSON.parse(result.block.contractData!);
          console.log(`[StorageManager] Reward issued: ${data.amount} milli-UNIT for ${pub.slice(0, 12)}...`);
          this.emit('storage:reward-issued', { pub, amount: data.amount, epochDay });
        } catch { /* ignore */ }
      }
    }
  }

  // ── Provider selection ────────────────────────────────────────────────────

  /**
   * Select up to `count` storage providers using weighted-random selection.
   * Weight = capacityGB × max(0.1, score). Local accounts are excluded.
   */
  selectProviders(count: number): StorageProvider[] {
    const localDeviceId = getDeviceId();
    // Exclude providers registered on this physical device - their content is already local.
    // Providers on other devices are eligible even if the same account key is loaded here.
    const allProviders = this.ledger.getStorageProviders();
    const candidates = allProviders.filter(p => !p.deviceId || p.deviceId !== localDeviceId);

    console.log(`[StorageManager] selectProviders: ${allProviders.length} total, ${candidates.length} remote candidates (want ${count})`);
    if (candidates.length > 0) {
      console.log(`[StorageManager] selectProviders candidates:`, candidates.map(p => `${p.pub.slice(0, 12)}… cap=${p.capacityGB}GB score=${p.score.toFixed(3)}`));
    }

    if (candidates.length === 0) return [];

    // A6: cap contribution at 100GB to prevent one large provider monopolising selection
    const weights = candidates.map(p => Math.max(0.01, Math.min(p.capacityGB, 100) * Math.max(0.1, p.score)));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const take = Math.min(count, candidates.length);

    const selected: StorageProvider[] = [];
    const usedIdx = new Set<number>();

    for (let attempt = 0; attempt < take * 4 && selected.length < take; attempt++) {
      let r = Math.random() * totalWeight;
      for (let i = 0; i < candidates.length; i++) {
        r -= weights[i];
        if (r <= 0 && !usedIdx.has(i)) {
          usedIdx.add(i);
          selected.push(candidates[i]);
          break;
        }
      }
    }

    return selected;
  }

  // ── Content distribution ──────────────────────────────────────────────────

  /** Retry distribution for CIDs that failed earlier because no providers existed. */
  private async retryPendingDistributions(): Promise<void> {
    if (this.pendingCids.size === 0) return;
    if (this.selectProviders(1).length === 0) return;

    for (const [cid, { ownerPub, additionalCids }] of this.pendingCids) {
      const keys = this.localKeys.get(ownerPub);
      if (!keys) continue;
      const result = await this.distributeContent(cid, ownerPub, keys, additionalCids);
      if (result.providers.length > 0) {
        this.pendingCids.delete(cid);
        console.log(`[StorageManager] Retried distribution for ${cid.slice(0, 16)}... → ${result.providers.length} providers`);
      }
    }
  }

  /** Resend cache requests for CIDs that have no confirmed provider yet, or are under-replicated. */
  private async retryUnconfirmedDistributions(): Promise<void> {
    if (this.trackedCids.size === 0) return;
    if (this.selectProviders(1).length === 0) return;
    const now = Date.now();
    for (const [cid, tracked] of this.trackedCids) {
      if (now - tracked.lastDistributed < 25_000) continue; // too soon to retry
      const keys = this.localKeys.get(tracked.ownerPub);
      if (!keys) continue;

      const confirmed = tracked.confirmedProviders.size;
      if (confirmed === 0) {
        // No confirmed providers - full redistribution
        tracked.lastDistributed = now;
        await this.distributeContent(cid, tracked.ownerPub, keys, tracked.additionalCids);
      } else if (confirmed < REDUNDANCY_TARGET / 2) {
        // Under-replicated (below half target) - top up with additional providers,
        // excluding those already confirmed so we don't ask them to re-cache.
        const additional = this.selectProviders(REDUNDANCY_TARGET).filter(
          p => !tracked.confirmedProviders.has(p.pub),
        );
        if (additional.length === 0) continue;
        tracked.lastDistributed = now;
        const ts = Date.now();
        const payload = `cache:${cid}:${tracked.ownerPub}:${ts}`;
        const sig = await signData(payload, keys);
        const uploaderSmokeAddr = await this.store.getSmokeHostname();
        this.net.publishCacheRequest({
          cid,
          additionalCids: tracked.additionalCids.length > 0 ? tracked.additionalCids : undefined,
          targetProviders: additional.map(p => p.pub),
          uploaderPub: tracked.ownerPub,
          uploaderSmokeAddr,
          timestamp: ts,
          signature: sig,
        });
        console.log(`[StorageManager] Re-replication: ${cid.slice(0, 16)}... at ${confirmed}/${REDUNDANCY_TARGET} copies → adding ${additional.length} providers`);
      }
    }
  }

  /**
   * Distribute stored CIDs to up to REDUNDANCY_TARGET providers.
   * `cid` is the primary (meta) CID; `additionalCids` are bundled in the same cache
   * request so providers cache both the envelope and the content block together.
   */
  async distributeContent(
    cid: string,
    uploaderPub: string,
    keys: KeyPair,
    additionalCids: string[] = [],
  ): Promise<{ providers: string[]; error?: string }> {
    console.log(`[StorageManager] distributeContent: cid=${cid.slice(0, 20)}… additionalCids=${additionalCids.length} uploader=${uploaderPub.slice(0, 12)}…`);
    const providers = this.selectProviders(REDUNDANCY_TARGET);
    if (providers.length === 0) {
      console.warn(`[StorageManager] distributeContent: no remote providers — storing locally only`);
      this.pendingCids.set(cid, { ownerPub: uploaderPub, additionalCids });
      return { providers: [], error: 'No storage providers available - content stored locally only' };
    }

    const ts = Date.now();
    const payload = `cache:${cid}:${uploaderPub}:${ts}`;
    const signature = await signData(payload, keys);

    // Include our smoke Hub address so providers can Http.fetch blocks via WebRTC
    const uploaderSmokeAddr = await this.store.getSmokeHostname();
    console.log(`[StorageManager] distributeContent: uploaderSmokeAddr=${uploaderSmokeAddr ?? '(none)'} publishing CacheRequest to ${providers.length} providers: ${providers.map(p => p.pub.slice(0, 12)).join(', ')}`);

    const request: CacheRequest = {
      cid,
      additionalCids: additionalCids.length > 0 ? additionalCids : undefined,
      targetProviders: providers.map(p => p.pub),
      uploaderPub,
      uploaderSmokeAddr,
      timestamp: ts,
      signature,
    };

    this.net.publishCacheRequest(request);

    const entry = { ownerPub: uploaderPub, confirmedProviders: new Set<string>(), additionalCids, lastDistributed: Date.now() };
    this.trackedCids.set(cid, entry);
    this.net.saveTrackedCid({ cid, ownerPub: uploaderPub, confirmedProviders: [], additionalCids, lastDistributed: entry.lastDistributed });

    console.log(`[StorageManager] Cache request published for ${cid.slice(0, 16)}... (+${additionalCids.length} extra) to ${providers.length} providers`);
    return { providers: providers.map(p => p.pub) };
  }

  // ── Pin request handling (provider side) ─────────────────────────────────

  private async handleCacheRequest(req: CacheRequest): Promise<void> {
    // Check if we are one of the target providers
    const myProviderPub = Array.from(this.localKeys.keys()).find(pub => req.targetProviders.includes(pub));
    console.log(`[StorageManager] handleCacheRequest: cid=${req.cid.slice(0, 20)}… targets=${req.targetProviders.length} additionalCids=${req.additionalCids?.length ?? 0} iAmTarget=${!!myProviderPub}`);
    if (!myProviderPub) {
      return;
    }

    const provider = this.ledger.storageProviders.get(myProviderPub);
    if (!provider || provider.capacityGB === 0) {
      return;
    }

    // Only the device that registered should serve - prevents both devices from
    // responding when the same account is loaded on two machines.
    const localDeviceId = getDeviceId();
    if (provider.deviceId && localDeviceId && provider.deviceId !== localDeviceId) {
      return;
    }

    // Verify the uploader's signature
    const payload = `cache:${req.cid}:${req.uploaderPub}:${req.timestamp}`;
    try {
      const verified = await verifySignature(req.signature, req.uploaderPub);
      if (verified !== payload) {
        console.warn(`[StorageManager] Rejected cache request - invalid signature`);
        return;
      }
    } catch {
      console.warn(`[StorageManager] Rejected cache request - signature verification failed`);
      return;
    }

    // Pin content via smoke Http (HTTP-over-WebRTC). The uploader's smoke Hub address
    // is in req.uploaderSmokeAddr - smoke's Net module uses the hub to exchange WebRTC
    // ICE candidates and establish a direct data-channel connection to the uploader.
    if (!this.store.isStarted()) { console.warn('[StorageManager] SmokeStore not started, cannot cache'); return; }
    try {
      const start = Date.now();
      const allCids = [req.cid, ...(Array.isArray(req.additionalCids) ? req.additionalCids : [])];
      console.log(`[StorageManager] handleCacheRequest: starting cache of ${allCids.length} CID(s) via smokeAddr=${req.uploaderSmokeAddr ?? '(none)'}`);
      for (const c of allCids) {
        console.log(`[StorageManager] handleCacheRequest: caching ${c.slice(0, 20)}…`);
        await this.store.cache(c, 600_000, req.uploaderSmokeAddr as string | undefined, req.uploaderPub as string | undefined);
        console.log(`[StorageManager] handleCacheRequest: cached ${c.slice(0, 20)}… OK`);
      }
      const latencyMs = Date.now() - start;
      console.log(`[StorageManager] Cached ${req.cid.slice(0, 16)}... in ${latencyMs}ms`);

      // Emit a receipt so other nodes can update our score and learn our smoke address
      if (this.net.running) {
        const keys = this.localKeys.get(myProviderPub);
        if (keys) {
          const providerSmokeAddr = await this.store.getSmokeHostname();
          const receiptPayload = `receipt:${req.cid}:${myProviderPub}:${myProviderPub}:${latencyMs}:true:${Date.now()}`;
          const sig = await signData(receiptPayload, keys);
          const receipt: StorageReceipt = {
            providerPub: myProviderPub,
            requesterPub: myProviderPub,
            cid: req.cid,
            latencyMs,
            success: true,
            timestamp: Date.now(),
            signature: sig,
            providerSmokeAddr,
          };
          this.net.publishStorageReceipt(receipt);
        }
      }

      this.emit('storage:cached', { pub: myProviderPub, cid: req.cid });
    } catch (err) {
      let msg: string;
      if (err instanceof AggregateError) {
        msg = '[' + (err.errors as unknown[]).map(e => e instanceof Error ? e.message : String(e)).join('; ') + ']';
      } else {
        msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
      }
      console.warn(`[StorageManager] Failed to cache ${req.cid.slice(0, 16)}...: ${msg}`);
    }
  }

  // ── Delete request handling ───────────────────────────────────────────────

  private async handleDeleteRequest(req: DeleteRequest): Promise<void> {
    if (!Array.isArray(req.cids) || !req.ownerPub || !req.signature) return;

    const payload = `delete:${req.cids.join(',')}:${req.ownerPub}:${req.timestamp}`;
    try {
      const verified = await verifySignature(req.signature, req.ownerPub);
      if (verified !== payload) {
        console.warn('[StorageManager] Rejected delete request - invalid signature');
        return;
      }
    } catch {
      console.warn('[StorageManager] Rejected delete request - signature verification failed');
      return;
    }

    if (!this.store.isStarted()) return;
    for (const cid of req.cids) {
      // Verify the requester is the account that originally uploaded this block.
      // Skip the check if we have no metadata (block wasn't cached by us, or pre-dates this fix).
      const meta = await this.store.getCachedMeta(cid);
      if (meta?.uploaderPub && meta.uploaderPub !== req.ownerPub) {
        console.warn(`[StorageManager] Rejected delete for ${cid.slice(0, 16)}: ownerPub mismatch`);
        continue;
      }
      await this.store.deleteBlock(cid);
    }
    // Remove from tracked CIDs so we stop retrying distribution
    if (req.cids.length > 0) {
      const primaryCid = req.cids[0];
      this.trackedCids.delete(primaryCid);
      this.net.deleteTrackedCid(primaryCid);
    }
  }

  // ── Replace request (owner initiates) ────────────────────────────────────

  /**
   * Replace content across the network. Broadcasts a signed ReplaceRequest so
   * every provider holding the old CID drops it and caches the new CID.
   * Also redistributes the new CID to up to REDUNDANCY_TARGET providers.
   * Call storeContent / storeContentPublic first to obtain newCid.
   */
  async replaceContent(
    oldCid: string,
    newCid: string,
    ownerPub: string,
    keys: KeyPair,
    oldAdditionalCids: string[] = [],
    newAdditionalCids: string[] = [],
  ): Promise<{ providers: string[]; error?: string }> {
    const ts = Date.now();
    const payload = `replace:${oldCid}:${newCid}:${ownerPub}:${ts}`;
    const signature = await signData(payload, keys);
    const uploaderSmokeAddr = await this.store.getSmokeHostname();

    const request: ReplaceRequest = {
      oldCid,
      oldAdditionalCids: oldAdditionalCids.length > 0 ? oldAdditionalCids : undefined,
      newCid,
      newAdditionalCids: newAdditionalCids.length > 0 ? newAdditionalCids : undefined,
      ownerPub,
      uploaderSmokeAddr,
      timestamp: ts,
      signature,
    };
    this.net.publishReplaceRequest(request as unknown as Record<string, unknown>);

    // Remove old tracked CID tracking so retries don't re-distribute it
    this.trackedCids.delete(oldCid);
    this.net.deleteTrackedCid(oldCid);
    // Transfer known smoke addresses for the old CID to the new one
    const oldAddrs = this.cidToSmokeAddrs.get(oldCid);
    if (oldAddrs) {
      this.cidToSmokeAddrs.delete(oldCid);
      const newAddrs = this.cidToSmokeAddrs.get(newCid) ?? new Set<string>();
      for (const a of oldAddrs) newAddrs.add(a);
      this.cidToSmokeAddrs.set(newCid, newAddrs);
    }

    // Distribute new content to providers (CacheRequest path)
    const result = await this.distributeContent(newCid, ownerPub, keys, newAdditionalCids);
    console.log(`[StorageManager] Replace broadcast: ${oldCid.slice(0, 16)}… → ${newCid.slice(0, 16)}… (${result.providers.length} providers)`);
    return result;
  }

  // ── Replace request handling (provider side) ──────────────────────────────

  private async handleReplaceRequest(req: ReplaceRequest): Promise<void> {
    if (!req.oldCid || !req.newCid || !req.ownerPub || !req.signature) return;

    const payload = `replace:${req.oldCid}:${req.newCid}:${req.ownerPub}:${req.timestamp}`;
    try {
      const verified = await verifySignature(req.signature, req.ownerPub);
      if (verified !== payload) {
        console.warn('[StorageManager] Rejected replace request - invalid signature');
        return;
      }
    } catch {
      console.warn('[StorageManager] Rejected replace request - signature verification failed');
      return;
    }

    if (!this.store.isStarted()) return;

    const oldCids = [req.oldCid, ...(Array.isArray(req.oldAdditionalCids) ? req.oldAdditionalCids : [])];
    const newCids = [req.newCid, ...(Array.isArray(req.newAdditionalCids) ? req.newAdditionalCids : [])];

    // Determine whether we are a provider that had the old content cached
    const myProviderPub = Array.from(this.localKeys.keys()).find(pub => {
      const provider = this.ledger.storageProviders.get(pub);
      return provider && provider.capacityGB > 0;
    });

    let wasProvider = false;
    if (myProviderPub) {
      const localDeviceId = getDeviceId();
      const provider = this.ledger.storageProviders.get(myProviderPub);
      if (provider && (!provider.deviceId || provider.deviceId === localDeviceId)) {
        wasProvider = await this.store.isCached(req.oldCid);
      }
    }

    // Drop all old blocks from local storage (idempotent for non-holders)
    for (const cid of oldCids) {
      await this.store.deleteBlock(cid);
    }

    // Providers that held the old content fetch and cache the new content
    if (wasProvider && myProviderPub) {
      try {
        for (const cid of newCids) {
          await this.store.cache(cid, 600_000, req.uploaderSmokeAddr as string | undefined, req.ownerPub);
        }
        const keys = this.localKeys.get(myProviderPub);
        if (keys && this.net.running) {
          const providerSmokeAddr = await this.store.getSmokeHostname();
          const ts = Date.now();
          const receiptPayload = `receipt:${req.newCid}:${myProviderPub}:${myProviderPub}:0:true:${ts}`;
          const sig = await signData(receiptPayload, keys);
          const receipt: StorageReceipt = {
            providerPub: myProviderPub, requesterPub: myProviderPub,
            cid: req.newCid, latencyMs: 0, success: true,
            timestamp: ts, signature: sig, providerSmokeAddr,
          };
          this.net.publishStorageReceipt(receipt);
        }
        console.log(`[StorageManager] Provider replaced: ${req.oldCid.slice(0, 16)}… → ${req.newCid.slice(0, 16)}…`);
        this.emit('storage:replaced', { pub: myProviderPub, oldCid: req.oldCid, newCid: req.newCid });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[StorageManager] Failed to cache replacement ${req.newCid.slice(0, 16)}…: ${msg}`);
      }
    }

    // Remove old tracking entry if this node was the owner tracking it
    const oldTracked = this.trackedCids.get(req.oldCid);
    if (oldTracked && oldTracked.ownerPub === req.ownerPub) {
      this.trackedCids.delete(req.oldCid);
      this.net.deleteTrackedCid(req.oldCid);
    }
  }

  // ── Receipt handling ──────────────────────────────────────────────────────

  handleReceipt(receipt: StorageReceipt): void {
    console.log(`[StorageManager] handleReceipt: cid=${receipt.cid.slice(0, 20)}… provider=${receipt.providerPub.slice(0, 12)}… success=${receipt.success} latency=${receipt.latencyMs}ms`);
    // Mark provider as confirmed for this CID so we stop retrying
    if (receipt.success) {
      const tracked = this.trackedCids.get(receipt.cid);
      if (tracked) {
        tracked.confirmedProviders.add(receipt.providerPub);
        console.log(`[StorageManager] handleReceipt: confirmed providers for ${receipt.cid.slice(0, 20)}… = ${tracked.confirmedProviders.size}`);
        // Persist updated confirmed providers
        this.net.saveTrackedCid({ cid: receipt.cid, ownerPub: tracked.ownerPub, confirmedProviders: Array.from(tracked.confirmedProviders), additionalCids: tracked.additionalCids, lastDistributed: tracked.lastDistributed });
      }
      // Register provider's smoke address for general fallback and per-CID targeted retrieval
      if (receipt.providerSmokeAddr) {
        this.store.addPeerFallback(receipt.providerSmokeAddr);
        const existing = this.cidToSmokeAddrs.get(receipt.cid) ?? new Set<string>();
        existing.add(receipt.providerSmokeAddr);
        this.cidToSmokeAddrs.set(receipt.cid, existing);
      }
    }

    // Self-signed receipts (provider confirming their own cache) only serve as
    // an acknowledgment - they don't affect score metrics. Only third-party receipts
    // (from spot-checkers) are counted toward latency and pass rate.
    if (receipt.requesterPub === receipt.providerPub) return;

    // Prune receipts older than 24h
    const cutoff = Date.now() - RECEIPT_WINDOW_MS;
    const list = (this.receipts.get(receipt.providerPub) || []).filter(r => r.timestamp > cutoff);
    list.push(receipt);
    this.receipts.set(receipt.providerPub, list);

    // Update provider off-chain metrics.
    // If the receipt carries rank info, inflate effective latency for later responders
    // so the score formula rewards being first-to-respond, not just fast on average.
    const provider = this.ledger.storageProviders.get(receipt.providerPub);
    if (provider) {
      const successful = list.filter(r => r.success);
      provider.spotCheckPassRate = list.length > 0 ? successful.length / list.length : 1.0;
      if (successful.length > 0) {
        const adjustedLatencies = successful.map(r => {
          const rankMultiplier = (r.responseRank && r.totalProviders && r.totalProviders > 1)
            ? 1 + (r.responseRank - 1) / r.totalProviders
            : 1.0;
          return r.latencyMs * rankMultiplier;
        });
        provider.avgLatencyMs = adjustedLatencies.reduce((s, v) => s + v, 0) / adjustedLatencies.length;
      }
      this.ledger.updateProviderScore(provider);
    }
  }

  // ── Spot checks ───────────────────────────────────────────────────────────

  /**
   * Periodically spot-check providers by fetching a block directly from each provider's
   * smoke address. All providers for a given CID are checked in parallel; the response
   * arrival order is tracked so faster providers receive a higher score.
   *
   * Only third-party-signed receipts (requesterPub ≠ providerPub) affect scores -
   * this prevents providers from gaming metrics by self-signing.
   */
  private async runSpotChecks(): Promise<void> {
    if (!this.store.isStarted()) return;

    const myPub = Array.from(this.localKeys.keys())[0];
    const myKeys = myPub ? this.localKeys.get(myPub) : undefined;
    if (!myPub || !myKeys) return;

    for (const [cid, tracked] of this.trackedCids) {
      // Gather confirmed providers that have a known smoke address
      const providerEntries = Array.from(tracked.confirmedProviders)
        .map(pub => ({ pub, provider: this.ledger.storageProviders.get(pub) }))
        .filter((e): e is { pub: string; provider: NonNullable<typeof e.provider> } =>
          !!e.provider?.smokeAddr);

      if (providerEntries.length === 0) continue;

      const totalProviders = providerEntries.length;
      let rankCounter = 0;

      await Promise.allSettled(providerEntries.map(async ({ pub, provider }) => {
        const start = Date.now();
        let latencyMs = 9999;
        let success = false;
        let responseRank: number | undefined;

        try {
          const fetchedBytes = await this.store.fetchBlockFromProvider(provider.smokeAddr!, cid, 8_000);

          // Proof of retrievability: since blocks are content-addressed, the CID IS the
          // SHA-256 hash. If the provider serves bytes that don't hash to the CID they are
          // serving tampered or corrupted data. No local copy needed for verification.
          const integrous = await this.store.verifyBlockIntegrity(cid, fetchedBytes);
          if (!integrous) {
            console.warn(`[StorageManager] CID integrity failure from ${pub.slice(0, 12)}… - block is tampered`);
            tracked.confirmedProviders.delete(pub);
            // fall through to receipt with success=false and latencyMs=9999
          } else {
            latencyMs = Date.now() - start;
            success = true;
            responseRank = ++rankCounter; // atomic: only one microtask runs at a time
          }
        } catch {
          // provider failed to serve the block
          tracked.confirmedProviders.delete(pub); // remove from confirmed so re-replication kicks in
        }

        const ts = Date.now();
        const payload = `receipt:${cid}:${pub}:${myPub}:${latencyMs}:${success}:${ts}`;
        const sig = await signData(payload, myKeys!);
        const receipt: StorageReceipt = {
          providerPub: pub,
          requesterPub: myPub,
          cid,
          latencyMs,
          success,
          timestamp: ts,
          signature: sig,
          providerSmokeAddr: provider.smokeAddr,
          responseRank,
          totalProviders,
        };
        this.net.publishStorageReceipt(receipt);
        this.handleReceipt(receipt);
      }));
    }
  }

  // ── Block submission (via ledger + net, same as current impl) ────────────

  private async submitBlock(block: AccountBlock): Promise<{ success: boolean; error?: string }> {
    const result = await this.ledger.addBlock(block);
    if (result.success) this.net.publishBlock(block);
    return result;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getReceipts(providerPub: string): StorageReceipt[] {
    return this.receipts.get(providerPub) || [];
  }

  getTrackedCids(): Map<string, { ownerPub: string; confirmedProviders: Set<string> }> {
    return this.trackedCids;
  }

  /** Return known provider smoke addresses for a specific CID, for targeted retrieval. */
  getCidSmokeAddrs(cid: string): string[] {
    return Array.from(this.cidToSmokeAddrs.get(cid) ?? []);
  }

  /**
   * Retrieve a block, routing to known providers for this CID first.
   * Wraps SmokeStore.retrieve() with per-CID peer hints so retrieval doesn't
   * broadcast to all peerFallbacks when we know exactly who holds the data.
   */
  async retrieve(cid: string, timeoutMs?: number): Promise<Uint8Array> {
    return this.store.retrieve(cid, timeoutMs, this.getCidSmokeAddrs(cid));
  }

  /** Check whether a local account is registered as a storage provider */
  isServing(pub: string): boolean {
    const provider = this.ledger.storageProviders.get(pub);
    return !!provider && provider.capacityGB > 0;
  }

  /** Get uptime percentage for a provider based on today's heartbeat count */
  getUptimePct(pub: string): number {
    const provider = this.ledger.storageProviders.get(pub);
    if (!provider) return 0;
    return Math.round((provider.heartbeatsLast24h / 6) * 100); // MAX_HEARTBEATS_PER_DAY = 6
  }
}
