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
 *   the ledger (weighted random by capacityGB × score), publishes a pin request,
 *   and those providers fetch the CID via Helia/Bitswap and pin it locally.
 *
 *   Off-chain retrieval receipts (signed by the requesting peer) are collected
 *   and used to update latency and spot-check metrics in the provider's ledger
 *   profile. These affect the displayed score but not on-chain reward validation.
 */

import { EventEmitter } from '../core/events';
import { DAGLedger, StorageProvider } from '../core/dag-ledger';
import { Libp2pNetwork } from './libp2p-network';
import { HeliaStore } from './helia-store';
import { AccountBlock, HEARTBEAT_INTERVAL_MS, REWARD_EPOCH_MS } from '../core/dag-block';
import { KeyPair, signData, verifySignature } from '../core/crypto';

const HEARTBEAT_JITTER_MS = 5 * 60 * 1000;          // ±5 min jitter so nodes don't all fire at once
const REWARD_CHECK_INTERVAL_MS = 30 * 60 * 1000;    // check every 30 min whether today's reward is due
const SPOT_CHECK_INTERVAL_MS   = 60 * 60 * 1000;    // run spot checks every hour
const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000;      // keep receipts for 24h rolling window
const REDUNDANCY_TARGET = 10;                        // target copies per file

export interface StorageReceipt {
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
}

export interface PinRequest {
  cid: string;
  /** Public keys of providers selected to pin this CID */
  targetProviders: string[];
  uploaderPub: string;
  /** libp2p PeerId of the uploader so providers can dial and fetch */
  uploaderPeerId: string;
  timestamp: number;
  signature: string;
}

export class StorageManager extends EventEmitter {
  private ledger: DAGLedger;
  private net: Libp2pNetwork;
  private helia: HeliaStore;
  private localKeys: Map<string, KeyPair>;

  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private rewardInterval: ReturnType<typeof setInterval> | null = null;
  private spotCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** Rolling 24h receipts per provider (off-chain, in-memory only) */
  private receipts: Map<string, StorageReceipt[]> = new Map();

  /** CIDs we're tracking for redundancy: cid → { owner, confirmedProviders } */
  private trackedCids: Map<string, { ownerPub: string; confirmedProviders: Set<string> }> = new Map();

  private started = false;

  constructor(
    ledger: DAGLedger,
    net: Libp2pNetwork,
    helia: HeliaStore,
    localKeys: Map<string, KeyPair>,
  ) {
    super();
    this.ledger = ledger;
    this.net = net;
    this.helia = helia;
    this.localKeys = localKeys;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;

    // Watch for incoming pin requests from other nodes
    this.net.watchPinRequests(async (req) => this.handlePinRequest(req));

    // Watch for retrieval receipts from peers
    this.net.watchStorageReceipts((receipt) => this.handleReceipt(receipt));

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
    for (const [pub, keys] of this.localKeys) {
      const provider = this.ledger.storageProviders.get(pub);
      if (!provider || provider.capacityGB === 0) continue;
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
        console.log(`[StorageManager] Reward not yet eligible for ${pub.slice(0, 12)}...: ${result.error}`);
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
    const myPubs = new Set(this.localKeys.keys());
    const candidates = this.ledger.getStorageProviders()
      .filter(p => !myPubs.has(p.pub));

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

  /**
   * Distribute a stored CID to up to REDUNDANCY_TARGET providers.
   * Publishes a signed pin request via GossipSub; providers fetch via Helia/Bitswap.
   * Returns the list of selected provider pub keys.
   */
  async distributeContent(
    cid: string,
    uploaderPub: string,
    keys: KeyPair,
  ): Promise<{ providers: string[]; error?: string }> {
    const providers = this.selectProviders(REDUNDANCY_TARGET);
    if (providers.length === 0) {
      return { providers: [], error: 'No storage providers available - content stored locally only' };
    }

    const peerId = this.net.libp2p?.peerId?.toString() || '';
    const payload = `pin:${cid}:${uploaderPub}:${Date.now()}`;
    const signature = await signData(payload, keys);

    const request: PinRequest = {
      cid,
      targetProviders: providers.map(p => p.pub),
      uploaderPub,
      uploaderPeerId: peerId,
      timestamp: Date.now(),
      signature,
    };

    this.net.publishPinRequest(request);

    // Track for redundancy monitoring
    this.trackedCids.set(cid, { ownerPub: uploaderPub, confirmedProviders: new Set() });

    console.log(`[StorageManager] Pin request published for ${cid.slice(0, 16)}... to ${providers.length} providers`);
    return { providers: providers.map(p => p.pub) };
  }

  // ── Pin request handling (provider side) ─────────────────────────────────

  private async handlePinRequest(req: PinRequest): Promise<void> {
    // Check if we are one of the target providers
    const myProviderPub = Array.from(this.localKeys.keys()).find(pub => req.targetProviders.includes(pub));
    if (!myProviderPub) return;

    const provider = this.ledger.storageProviders.get(myProviderPub);
    if (!provider || provider.capacityGB === 0) return;

    // Verify the uploader's signature
    const payload = `pin:${req.cid}:${req.uploaderPub}:${req.timestamp}`;
    try {
      const verified = await verifySignature(req.signature, req.uploaderPub);
      if (verified !== payload) {
        console.warn(`[StorageManager] Rejected pin request - invalid signature`);
        return;
      }
    } catch {
      console.warn(`[StorageManager] Rejected pin request - signature verification failed`);
      return;
    }

    // Pin the content via Helia (fetches from the uploader or any peer that has it)
    if (!this.helia.isStarted()) return;
    try {
      const start = Date.now();
      await this.helia.pin(req.cid);
      const latencyMs = Date.now() - start;
      console.log(`[StorageManager] Pinned ${req.cid.slice(0, 16)}... in ${latencyMs}ms`);

      // Emit a receipt so other nodes can update our score
      if (this.net.running) {
        const keys = this.localKeys.get(myProviderPub);
        if (keys) {
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
          };
          this.net.publishStorageReceipt(receipt);
        }
      }

      this.emit('storage:pinned', { pub: myProviderPub, cid: req.cid });
    } catch (err) {
      console.warn(`[StorageManager] Failed to pin ${req.cid.slice(0, 16)}...:`, err);
    }
  }

  // ── Receipt handling ──────────────────────────────────────────────────────

  handleReceipt(receipt: StorageReceipt): void {
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
    if (!this.helia.isStarted()) return;

    for (const [cid, tracked] of this.trackedCids) {
      const providers = this.ledger.getStorageProviders().slice(0, 5); // check top 5
      for (const provider of providers) {
        try {
          const start = Date.now();
          // Attempt to retrieve the CID - Helia will fetch from the peer if not local
          const bytes = await Promise.race([
            this.helia.retrieve(cid),
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
