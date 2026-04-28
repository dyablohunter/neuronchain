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
  /** Smoke Hub address of the provider — other nodes use this for Http.fetch fallback */
  providerSmokeAddr?: string;
}

export interface CacheRequest {
  [key: string]: unknown;
  cid: string;
  /** Additional CIDs that must also be cached (e.g. contentCid inside a meta envelope) */
  additionalCids?: string[];
  /** Public keys of providers selected to cache this CID */
  targetProviders: string[];
  uploaderPub: string;
  /** Smoke Hub address of the uploader — providers use Http.fetch to pull blocks via WebRTC */
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

  start(): void {
    if (this.started) return;
    this.started = true;

    // Watch for incoming cache requests from other nodes.
    // Every node — not just providers — registers the uploader's smoke address so
    // retrieve() can fetch directly from the uploader via WebRTC if needed.
    this.net.watchCacheRequests(async (req) => {
      const r = req as unknown as CacheRequest;
      if (r.uploaderSmokeAddr) this.store.addPeerFallback(r.uploaderSmokeAddr);
      await this.handleCacheRequest(r);
    });

    // Watch for retrieval receipts from peers
    this.net.watchStorageReceipts((receipt) => this.handleReceipt(receipt as unknown as StorageReceipt));

    // Watch for content delete requests — any node that holds the blocks drops them
    this.net.watchDeleteRequests(async (req) => {
      await this.handleDeleteRequest(req as unknown as DeleteRequest);
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
    const result = await this.ledger.createStorageHeartbeat(pub, keys);
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
    // Exclude providers registered on this physical device — their content is already local.
    // Providers on other devices are eligible even if the same account key is loaded here.
    const candidates = this.ledger.getStorageProviders()
      .filter(p => !p.deviceId || p.deviceId !== localDeviceId);

    if (candidates.length === 0) return [];

    const weights = candidates.map(p => Math.max(0.01, p.capacityGB * Math.max(0.1, p.score)));
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

  /** Resend cache requests for CIDs that have no confirmed provider yet. */
  private async retryUnconfirmedDistributions(): Promise<void> {
    if (this.trackedCids.size === 0) return;
    if (this.selectProviders(1).length === 0) return;
    const now = Date.now();
    for (const [cid, tracked] of this.trackedCids) {
      if (tracked.confirmedProviders.size > 0) continue; // already confirmed
      if (now - tracked.lastDistributed < 25_000) continue; // too soon to retry
      const keys = this.localKeys.get(tracked.ownerPub);
      if (!keys) continue;
      tracked.lastDistributed = now;
      await this.distributeContent(cid, tracked.ownerPub, keys, tracked.additionalCids);
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
    const providers = this.selectProviders(REDUNDANCY_TARGET);
    if (providers.length === 0) {
      this.pendingCids.set(cid, { ownerPub: uploaderPub, additionalCids });
      return { providers: [], error: 'No storage providers available - content stored locally only' };
    }

    const ts = Date.now();
    const payload = `cache:${cid}:${uploaderPub}:${ts}`;
    const signature = await signData(payload, keys);

    // Include our smoke Hub address so providers can Http.fetch blocks via WebRTC
    const uploaderSmokeAddr = await this.store.getSmokeHostname();

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

    this.trackedCids.set(cid, { ownerPub: uploaderPub, confirmedProviders: new Set(), additionalCids, lastDistributed: Date.now() });

    console.log(`[StorageManager] Cache request published for ${cid.slice(0, 16)}... (+${additionalCids.length} extra) to ${providers.length} providers`);
    return { providers: providers.map(p => p.pub) };
  }

  // ── Pin request handling (provider side) ─────────────────────────────────

  private async handleCacheRequest(req: CacheRequest): Promise<void> {
    // Check if we are one of the target providers
    const myProviderPub = Array.from(this.localKeys.keys()).find(pub => req.targetProviders.includes(pub));
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
    // is in req.uploaderSmokeAddr — smoke's Net module uses the hub to exchange WebRTC
    // ICE candidates and establish a direct data-channel connection to the uploader.
    if (!this.store.isStarted()) { console.warn('[StorageManager] SmokeStore not started, cannot cache'); return; }
    try {
      const start = Date.now();
      const allCids = [req.cid, ...(Array.isArray(req.additionalCids) ? req.additionalCids : [])];
      for (const c of allCids) {
        await this.store.cache(c, 600_000, req.uploaderSmokeAddr as string | undefined);
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
      await this.store.deleteBlock(cid);
    }
    // Remove from tracked CIDs so we stop retrying distribution
    if (req.cids.length > 0) this.trackedCids.delete(req.cids[0]);
  }

  // ── Receipt handling ──────────────────────────────────────────────────────

  handleReceipt(receipt: StorageReceipt): void {
    // Mark provider as confirmed for this CID so we stop retrying
    if (receipt.success) {
      const tracked = this.trackedCids.get(receipt.cid);
      if (tracked) tracked.confirmedProviders.add(receipt.providerPub);
      // Register provider's smoke address so retrieve() can pull from them
      if (receipt.providerSmokeAddr) {
        this.store.addPeerFallback(receipt.providerSmokeAddr);
      }
    }

    // Prune receipts older than 24h
    const cutoff = Date.now() - RECEIPT_WINDOW_MS;
    const list = (this.receipts.get(receipt.providerPub) || []).filter(r => r.timestamp > cutoff);
    list.push(receipt);
    this.receipts.set(receipt.providerPub, list);

    // Update provider off-chain metrics
    const provider = this.ledger.storageProviders.get(receipt.providerPub);
    if (provider) {
      const successful = list.filter(r => r.success);
      provider.spotCheckPassRate = list.length > 0 ? successful.length / list.length : 1.0;
      if (successful.length > 0) {
        provider.avgLatencyMs = successful.reduce((sum, r) => sum + r.latencyMs, 0) / successful.length;
      }
      this.ledger.updateProviderScore(provider);
    }
  }

  // ── Spot checks ───────────────────────────────────────────────────────────

  /**
   * Periodically request known CIDs from providers to verify they still hold the data.
   * Generates a signed receipt on success/failure that updates the provider's score.
   */
  private async runSpotChecks(): Promise<void> {
    if (!this.store.isStarted()) return;

    for (const [cid, tracked] of this.trackedCids) {
      const providers = this.ledger.getStorageProviders().slice(0, 5); // check top 5
      for (const provider of providers) {
        try {
          const start = Date.now();
          // Attempt to retrieve the CID — tries local storage first, then peer fallbacks
          const bytes = await Promise.race([
            this.store.retrieve(cid),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8_000)),
          ]);
          const latencyMs = Date.now() - start;
          const success = bytes instanceof Uint8Array && bytes.length > 0;

          // Emit a receipt
          const myPub = Array.from(this.localKeys.keys())[0];
          const myKeys = myPub ? this.localKeys.get(myPub) : undefined;
          if (myPub && myKeys) {
            const payload = `receipt:${cid}:${provider.pub}:${myPub}:${latencyMs}:${success}:${Date.now()}`;
            const sig = await signData(payload, myKeys);
            const receipt: StorageReceipt = {
              providerPub: provider.pub,
              requesterPub: myPub,
              cid,
              latencyMs,
              success,
              timestamp: Date.now(),
              signature: sig,
            };
            this.net.publishStorageReceipt(receipt);
            this.handleReceipt(receipt);
          }
        } catch {
          // Spot check failed - record a failure receipt
          const myPub = Array.from(this.localKeys.keys())[0];
          const myKeys = myPub ? this.localKeys.get(myPub) : undefined;
          if (myPub && myKeys) {
            const payload = `receipt:${cid}:${provider.pub}:${myPub}:9999:false:${Date.now()}`;
            const sig = await signData(payload, myKeys);
            const receipt: StorageReceipt = {
              providerPub: provider.pub,
              requesterPub: myPub,
              cid,
              latencyMs: 9999,
              success: false,
              timestamp: Date.now(),
              signature: sig,
            };
            this.net.publishStorageReceipt(receipt);
            this.handleReceipt(receipt);
          }
        }
      }
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
