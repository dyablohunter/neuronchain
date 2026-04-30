import { signData, verifySignature, KeyPair } from './crypto';

/**
 * Optimistic Confirmation + Conflict-Only Voting.
 *
 * OPTIMISTIC: Blocks are confirmed INSTANTLY if they pass local validation
 * (valid signature, sufficient balance, no fork). No voting needed.
 *
 * CONFLICT VOTING: Only triggered when two blocks share the same parent
 * (fork = double-spend attempt). Peers vote with stake weight to pick
 * the winner. Loser is rejected and rolled back.
 *
 * This gives 10-50x throughput vs. vote-on-every-block.
 */

export interface Vote {
  blockHash: string;
  voterPub: string;
  approve: boolean;
  stake: number;
  timestamp: number;
  signature: string;
  /** Head block hash of voter's chain - allows receivers to verify balance */
  chainHeadHash?: string;
  /**
   * G6: true when the voter lacks parent-chain context and cannot make an
   * informed approve/reject decision. Abstain votes are signed and counted
   * toward participation but excluded from the approve/reject threshold.
   */
  abstain?: boolean;
}

export interface VoteTally {
  blockHash: string;
  approveStake: number;
  rejectStake: number;
  /** Stake from nodes that abstained (no parent context). Excluded from threshold. */
  abstainStake: number;
  totalStake: number;
  voterCount: number;
  votes: Map<string, Vote>;
  createdAt: number;
}

const CONFLICT_RESOLVE_THRESHOLD = 2 / 3;
const CONFLICT_RESOLVE_TIMEOUT_MS = 10_000;
/** Votes older than this are rejected to prevent replay of stale votes */
const VOTE_MAX_AGE_MS = 60_000;

export class VoteManager {
  private confirmedBlocks: Set<string> = new Set();
  private rejectedBlocks: Set<string> = new Set();
  /** Map of "accountPub:previousHash" → set of competing block hashes */
  private parentToBlocks: Map<string, Set<string>> = new Map();
  /** Only blocks in conflict get tallies */
  private tallies: Map<string, VoteTally> = new Map();
  /** Seen vote signatures - prevents replaying the exact same signed vote */
  private seenSignatures: Set<string> = new Set();

  private static readonly MAX_SEEN_SIGS = 50_000;

  /**
   * Register a block. If no conflict, it's confirmed optimistically.
   * If conflict detected, both blocks enter voting.
   * Returns 'confirmed' or 'conflict'.
   */
  registerBlock(blockHash: string, previousHash: string, accountPub: string): 'confirmed' | 'conflict' {
    if (this.confirmedBlocks.has(blockHash)) return 'confirmed';
    if (this.rejectedBlocks.has(blockHash)) return 'conflict';

    const key = `${accountPub}:${previousHash}`;
    if (!this.parentToBlocks.has(key)) {
      this.parentToBlocks.set(key, new Set());
    }
    const siblings = this.parentToBlocks.get(key)!;
    siblings.add(blockHash);

    if (siblings.size === 1) {
      // No conflict - optimistic confirmation
      this.confirmedBlocks.add(blockHash);
      return 'confirmed';
    }

    // CONFLICT DETECTED - revoke optimistic confirmations and start voting
    for (const hash of siblings) {
      this.confirmedBlocks.delete(hash);
      if (!this.tallies.has(hash)) {
        this.tallies.set(hash, {
          blockHash: hash,
          approveStake: 0,
          rejectStake: 0,
          abstainStake: 0,
          totalStake: 0,
          voterCount: 0,
          votes: new Map(),
          createdAt: Date.now(),
        });
      }
    }

    return 'conflict';
  }

  /**
   * Add a vote (only matters for conflicted blocks).
   */
  addVote(vote: Vote): void {
    const tally = this.tallies.get(vote.blockHash);
    if (!tally) return; // Not in conflict - no vote needed
    if (tally.votes.has(vote.voterPub)) return; // Already voted

    // Reject replayed signatures
    if (this.seenSignatures.has(vote.signature)) return;
    this.seenSignatures.add(vote.signature);
    if (this.seenSignatures.size > VoteManager.MAX_SEEN_SIGS) {
      const it = this.seenSignatures.values();
      this.seenSignatures.delete(it.next().value!);
    }

    // Reject stale votes (prevents replay of old votes with outdated stakes)
    if (Date.now() - vote.timestamp > VOTE_MAX_AGE_MS) return;

    tally.votes.set(vote.voterPub, vote);
    tally.voterCount++;
    if (vote.abstain) {
      // G6: abstain - counted for participation but not for approve/reject threshold
      tally.abstainStake += vote.stake;
    } else if (vote.approve) {
      tally.approveStake += vote.stake;
      tally.totalStake += vote.stake;
    } else {
      tally.rejectStake += vote.stake;
      tally.totalStake += vote.stake;
    }
  }

  /**
   * Get block status.
   */
  getStatus(blockHash: string): 'confirmed' | 'rejected' | 'pending' | 'conflict' {
    if (this.confirmedBlocks.has(blockHash)) return 'confirmed';
    if (this.rejectedBlocks.has(blockHash)) return 'rejected';
    if (this.tallies.has(blockHash)) return 'conflict';
    return 'pending';
  }

  /**
   * Process conflict resolution for all active conflicts.
   * Call periodically.
   */
  resolveConflicts(): { confirmed: string[]; rejected: string[] } {
    const confirmed: string[] = [];
    const rejected: string[] = [];

    for (const [key, siblings] of this.parentToBlocks) {
      if (siblings.size <= 1) continue; // No conflict

      const hashes = Array.from(siblings);
      const allHaveTallies = hashes.every((h) => this.tallies.has(h));
      if (!allHaveTallies) continue;

      // Find the block with the most approve stake
      let bestHash = '';
      let bestStake = -1;
      let allVoted = true;
      let oldestTally = Infinity;

      for (const hash of hashes) {
        const tally = this.tallies.get(hash)!;
        if (tally.createdAt < oldestTally) oldestTally = tally.createdAt;
        // G6: a tally of only abstains still counts as "voted" (nodes couldn't decide)
        if (tally.totalStake + tally.abstainStake === 0) allVoted = false;
        if (tally.approveStake > bestStake) {
          bestStake = tally.approveStake;
          bestHash = hash;
        }
      }

      // Resolve if: threshold met OR timeout expired
      const bestTally = this.tallies.get(bestHash);
      const thresholdMet = bestTally && bestTally.totalStake > 0 &&
        bestTally.approveStake / bestTally.totalStake >= CONFLICT_RESOLVE_THRESHOLD;
      const timedOut = Date.now() - oldestTally > CONFLICT_RESOLVE_TIMEOUT_MS;

      if (thresholdMet || (timedOut && bestStake > 0) || (timedOut && allVoted)) {
        // Winner
        this.confirmedBlocks.add(bestHash);
        this.tallies.delete(bestHash);
        confirmed.push(bestHash);

        // Losers
        for (const hash of hashes) {
          if (hash !== bestHash) {
            this.rejectedBlocks.add(hash);
            this.tallies.delete(hash);
            rejected.push(hash);
          }
        }
      }
    }

    return { confirmed, rejected };
  }

  getTally(blockHash: string): VoteTally | undefined {
    return this.tallies.get(blockHash);
  }

  isConfirmed(blockHash: string): boolean {
    return this.confirmedBlocks.has(blockHash);
  }

  hasConflict(blockHash: string): boolean {
    for (const [, siblings] of this.parentToBlocks) {
      if (siblings.has(blockHash) && siblings.size > 1) return true;
    }
    return false;
  }

  /** Create a signed vote with balance proof (chain head hash) */
  static async createVote(
    blockHash: string,
    approve: boolean,
    stake: number,
    keys: KeyPair,
    chainHeadHash?: string,
    abstain?: boolean,
  ): Promise<Vote> {
    const timestamp = Date.now();
    // G6: abstain flag is included in payload so it cannot be stripped without breaking the sig
    const payload = `vote:${blockHash}:${approve}:${stake}:${timestamp}:${chainHeadHash || ''}:${abstain ? '1' : '0'}`;
    const signature = await signData(payload, keys);
    return { blockHash, voterPub: keys.pub, approve, stake, timestamp, signature, chainHeadHash, abstain };
  }

  /** Verify a vote signature. Handles three payload formats for backwards compatibility. */
  static async verifyVote(vote: Vote): Promise<boolean> {
    const result = await verifySignature(vote.signature, vote.voterPub);
    // Current format: includes abstain flag
    const v3 = `vote:${vote.blockHash}:${vote.approve}:${vote.stake}:${vote.timestamp}:${vote.chainHeadHash || ''}:${vote.abstain ? '1' : '0'}`;
    if (result === v3) return true;
    // v2: includes chainHeadHash but no abstain
    const v2 = `vote:${vote.blockHash}:${vote.approve}:${vote.stake}:${vote.timestamp}:${vote.chainHeadHash || ''}`;
    if (result === v2) return true;
    // v1: original format without chainHeadHash
    const v1 = `vote:${vote.blockHash}:${vote.approve}:${vote.stake}:${vote.timestamp}`;
    return result === v1;
  }

  /** Return the hashes of blocks competing against the given block (its conflict siblings). */
  getSiblings(blockHash: string): string[] {
    for (const [, siblings] of this.parentToBlocks) {
      if (siblings.has(blockHash) && siblings.size > 1) {
        return Array.from(siblings).filter(h => h !== blockHash);
      }
    }
    return [];
  }

  clear(): void {
    this.tallies.clear();
    this.confirmedBlocks.clear();
    this.rejectedBlocks.clear();
    this.parentToBlocks.clear();
    this.seenSignatures.clear();
  }
}
