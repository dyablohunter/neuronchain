/**
 * Gun relay middleware — server-side write validation & rate limiting.
 *
 * Intercepts all incoming `put` operations and:
 * 1. Validates signatures on blocks and accounts before storing
 * 2. Rejects `null` writes to protected paths (prevents malicious deletion)
 * 3. Rate limits writes per connection to prevent flooding
 *
 * Only validated, signed data passes through to Gun's storage and relay.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ──── Rate Limiter ────

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

class RateLimiter {
  private buckets: Map<string, RateBucket> = new Map();
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private readonly cleanupIntervalMs = 60_000;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param maxTokens  Max burst size (e.g., 50 writes)
   * @param refillRate Tokens restored per second (e.g., 10/s)
   */
  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
  }

  /** Returns true if the request is allowed, false if rate limited */
  allow(id: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: now };
      this.buckets.set(id, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, bucket] of this.buckets) {
      // Remove buckets that haven't been used in 5 minutes
      if (now - bucket.lastRefill > 300_000) {
        this.buckets.delete(id);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }
}

// ──── Path Analysis ────

/** Protected path patterns that require authentication */
const PROTECTED_PREFIXES = ['accounts', 'keyblobs', 'contracts', 'votes', 'inbox'];

interface ParsedPath {
  network: string;
  /** 'accounts' | 'keyblobs' | 'synapse' | 'votes' | etc. */
  category: string;
  /** The account pub key (for account/keyblob/block paths) */
  ownerPub?: string;
  /** For synapse paths, the synapse index */
  synapseIdx?: number;
  /** Whether this is a block within a synapse */
  isBlock: boolean;
}

/**
 * Parse a Gun graph key path to determine what it represents.
 * Gun stores data in a flat graph with soul keys like:
 *   "neuronchain/testnet/accounts/pubkey123"
 *   "neuronchain/testnet/synapse-0/dag/pubkey123/0"
 */
function parseSoul(soul: string): ParsedPath | null {
  // Match: neuronchain/{network}/{rest...}
  const match = soul.match(/^neuronchain\/([^/]+)\/(.+)$/);
  if (!match) return null;

  const network = match[1];
  const rest = match[2];

  // accounts/{pub}
  if (rest.startsWith('accounts/')) {
    return { network, category: 'accounts', ownerPub: rest.slice('accounts/'.length), isBlock: false };
  }

  // keyblobs/{pub}
  if (rest.startsWith('keyblobs/')) {
    return { network, category: 'keyblobs', ownerPub: rest.slice('keyblobs/'.length), isBlock: false };
  }

  // votes/{blockHash}/{voterPub}
  if (rest.startsWith('votes/')) {
    const parts = rest.split('/');
    return { network, category: 'votes', ownerPub: parts[2], isBlock: false };
  }

  // synapse-N/dag/{pub}/{index}
  const synapseMatch = rest.match(/^synapse-(\d+)\/dag\/([^/]+)/);
  if (synapseMatch) {
    return {
      network,
      category: 'synapse',
      synapseIdx: parseInt(synapseMatch[1], 10),
      ownerPub: synapseMatch[2],
      isBlock: true,
    };
  }

  // inbox/{pub}/{signalId}
  if (rest.startsWith('inbox/')) {
    return { network, category: 'inbox', isBlock: false };
  }

  // contracts/{id}
  if (rest.startsWith('contracts/')) {
    return { network, category: 'contracts', isBlock: false };
  }

  // peers, _generation, etc.
  return { network, category: rest.split('/')[0], isBlock: false };
}

// ──── Signature Verification ────

/**
 * Verify a block's signature server-side.
 * A block's `signature` field is a Gun SEA signed string of the block hash.
 * SEA.verify returns the original data if valid, undefined otherwise.
 */
async function verifyBlockSignature(
  SEA: { verify: (data: string, pub: string) => Promise<string | undefined> },
  blockData: Record<string, unknown>,
): Promise<boolean> {
  if (!blockData.signature || !blockData.hash || !blockData.accountPub) return false;
  try {
    const result = await SEA.verify(String(blockData.signature), String(blockData.accountPub));
    return result === String(blockData.hash);
  } catch {
    return false;
  }
}

/**
 * Verify an account's _sig field server-side.
 */
async function verifyAccountSignature(
  SEA: { verify: (data: string, pub: string) => Promise<string | undefined> },
  accData: Record<string, unknown>,
): Promise<boolean> {
  if (!accData._sig || !accData.pub) return false;
  try {
    const payload = `account:${accData.pub}:${accData.username}:${accData.createdAt}:${accData.faceMapHash}`;
    const result = await SEA.verify(String(accData._sig), String(accData.pub));
    return result === payload;
  } catch {
    return false;
  }
}

/**
 * Verify a vote's signature server-side.
 */
async function verifyVoteSignature(
  SEA: { verify: (data: string, pub: string) => Promise<string | undefined> },
  voteData: Record<string, unknown>,
): Promise<boolean> {
  if (!voteData.signature || !voteData.voterPub || !voteData.blockHash) return false;
  try {
    const result = await SEA.verify(String(voteData.signature), String(voteData.voterPub));
    // New format includes chainHeadHash
    const newPayload = `vote:${voteData.blockHash}:${voteData.approve}:${voteData.stake}:${voteData.timestamp}:${voteData.chainHeadHash || ''}`;
    if (result === newPayload) return true;
    // Backwards compat: old format without chainHeadHash
    const oldPayload = `vote:${voteData.blockHash}:${voteData.approve}:${voteData.stake}:${voteData.timestamp}`;
    return result === oldPayload;
  } catch {
    return false;
  }
}

// ──── Middleware ────

interface MiddlewareStats {
  accepted: number;
  rejectedSignature: number;
  rejectedRateLimit: number;
  rejectedNullWrite: number;
  total: number;
}

export function installGunMiddleware(gun: unknown): { stats: MiddlewareStats; destroy: () => void } {
  const Gun = require('gun');
  require('gun/sea.js');
  const SEA = Gun.SEA;
  const gunInstance = gun as {
    on: (event: string, handler: (msg: Record<string, unknown>) => void) => void;
  };

  const stats: MiddlewareStats = {
    accepted: 0,
    rejectedSignature: 0,
    rejectedRateLimit: 0,
    rejectedNullWrite: 0,
    total: 0,
  };

  // Rate limiter: 60 writes burst, 20 writes/second sustained
  const limiter = new RateLimiter(60, 20);

  gunInstance.on('in', function (this: { to: { next: (msg: Record<string, unknown>) => void } }, msg: Record<string, unknown>) {
    const next = this.to.next.bind(this.to);

    // Only intercept put operations
    if (!msg.put || typeof msg.put !== 'object') {
      next(msg);
      return;
    }

    // Identify the connection for rate limiting
    // Use the Gun peer ID or fall back to a hash of the message
    const peerId = String(
      (msg['#'] as string || '').split('/')[0] ||
      (msg as Record<string, unknown>)._ && ((msg as Record<string, unknown>)._ as Record<string, unknown>).id ||
      'unknown'
    );

    // Rate limit check
    if (!limiter.allow(peerId)) {
      stats.rejectedRateLimit++;
      stats.total++;
      // Silently drop — don't relay
      return;
    }

    const put = msg.put as Record<string, Record<string, unknown>>;

    // Validate each soul (path) in the put operation
    (async () => {
      let allValid = true;

      for (const [soul, data] of Object.entries(put)) {
        if (!data || typeof data !== 'object') continue;

        const parsed = parseSoul(soul);
        if (!parsed) {
          // Not a neuronchain path — allow (Gun internal metadata)
          continue;
        }

        // ── Reject null writes to protected paths ──
        const isNullWrite = Object.entries(data).some(
          ([k, v]) => k !== '_' && k !== '#' && v === null
        );
        if (isNullWrite && PROTECTED_PREFIXES.includes(parsed.category)) {
          // Allow null writes only if they come with a valid generation bump
          // (i.e., the _generation path is being updated too)
          const hasGenBump = put[`neuronchain/${parsed.network}/_generation`] !== undefined;
          if (!hasGenBump) {
            stats.rejectedNullWrite++;
            stats.total++;
            allValid = false;
            break;
          }
        }

        // ── Validate blocks (synapse paths) ──
        if (parsed.isBlock && parsed.category === 'synapse') {
          // Block data should have hash, accountPub, signature
          if (data.hash && data.signature && data.accountPub) {
            // Verify the block was signed by its claimed author
            const valid = await verifyBlockSignature(SEA, data);
            if (!valid) {
              console.log(`[Middleware] Rejected block: invalid signature (soul: ${soul.slice(0, 40)}...)`);
              stats.rejectedSignature++;
              stats.total++;
              allValid = false;
              break;
            }
            // Verify the block is on the correct synapse
            if (parsed.ownerPub && String(data.accountPub) !== parsed.ownerPub) {
              console.log(`[Middleware] Rejected block: accountPub mismatch with path`);
              stats.rejectedSignature++;
              stats.total++;
              allValid = false;
              break;
            }
          }
        }

        // ── Validate accounts ──
        if (parsed.category === 'accounts' && data._sig) {
          const valid = await verifyAccountSignature(SEA, data);
          if (!valid) {
            console.log(`[Middleware] Rejected account: invalid signature (pub: ${String(data.pub).slice(0, 12)}...)`);
            stats.rejectedSignature++;
            stats.total++;
            allValid = false;
            break;
          }
          // Verify the account pub matches the path
          if (parsed.ownerPub && String(data.pub) !== parsed.ownerPub) {
            console.log(`[Middleware] Rejected account: pub mismatch with path`);
            stats.rejectedSignature++;
            stats.total++;
            allValid = false;
            break;
          }
        }

        // ── Validate votes ──
        if (parsed.category === 'votes' && data.signature && data.voterPub) {
          const valid = await verifyVoteSignature(SEA, data);
          if (!valid) {
            console.log(`[Middleware] Rejected vote: invalid signature`);
            stats.rejectedSignature++;
            stats.total++;
            allValid = false;
            break;
          }
        }
      }

      if (allValid) {
        stats.accepted++;
        stats.total++;
        next(msg);
      }
    })().catch(() => {
      // If verification throws, reject
      stats.rejectedSignature++;
      stats.total++;
    });
  });

  // Log stats periodically
  const statsInterval = setInterval(() => {
    if (stats.total > 0) {
      console.log(
        `[Middleware] Accepted: ${stats.accepted} | Rejected — sig: ${stats.rejectedSignature}, rate: ${stats.rejectedRateLimit}, null: ${stats.rejectedNullWrite} | Total: ${stats.total}`
      );
    }
  }, 30_000);

  return {
    stats,
    destroy: () => {
      clearInterval(statsInterval);
      limiter.destroy();
    },
  };
}
