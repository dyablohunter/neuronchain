import { signData, verifySignature, KeyPair } from './crypto';

/**
 * Stake-weighted voting for block confirmation.
 *
 * Each peer auto-votes on blocks they receive:
 * - Vote weight = voter's account balance (their stake)
 * - Confirmation: approving stake > 2/3 of total voted stake
 * - Conflict: if two blocks share the same previousHash (fork),
 *   the one with more stake-weighted votes wins
 *
 * Grace period: blocks auto-confirm after 10s if uncontested.
 */

export interface Vote {
  blockHash: string;
  voterPub: string;
  approve: boolean;
  stake: number;
  timestamp: number;
  signature: string;
}

export interface VoteTally {
  blockHash: string;
  approveStake: number;
  rejectStake: number;
  totalStake: number;
  voterCount: number;
  votes: Map<string, Vote>;
  createdAt: number;
}

const CONFIRMATION_THRESHOLD = 2 / 3;
const AUTO_CONFIRM_GRACE_MS = 10_000;

export class VoteManager {
  private tallies: Map<string, VoteTally> = new Map();
  private confirmedBlocks: Set<string> = new Set();
  private rejectedBlocks: Set<string> = new Set();
  /** Map of previousHash → set of competing block hashes (conflict detection) */
  private parentToBlocks: Map<string, Set<string>> = new Map();

  registerBlock(blockHash: string, previousHash: string, accountPub: string): void {
    if (!this.tallies.has(blockHash)) {
      this.tallies.set(blockHash, {
        blockHash,
        approveStake: 0,
        rejectStake: 0,
        totalStake: 0,
        voterCount: 0,
        votes: new Map(),
        createdAt: Date.now(),
      });
    }

    // Track parent → blocks for conflict detection
    const key = `${accountPub}:${previousHash}`;
    if (!this.parentToBlocks.has(key)) {
      this.parentToBlocks.set(key, new Set());
    }
    this.parentToBlocks.get(key)!.add(blockHash);
  }

  addVote(vote: Vote): void {
    const tally = this.tallies.get(vote.blockHash);
    if (!tally) return;
    if (tally.votes.has(vote.voterPub)) return; // Already voted

    tally.votes.set(vote.voterPub, vote);
    tally.voterCount++;

    if (vote.approve) {
      tally.approveStake += vote.stake;
    } else {
      tally.rejectStake += vote.stake;
    }
    tally.totalStake += vote.stake;
  }

  /**
   * Check if a block is confirmed.
   * Returns: 'confirmed' | 'rejected' | 'pending'
   */
  getStatus(blockHash: string): 'confirmed' | 'rejected' | 'pending' {
    if (this.confirmedBlocks.has(blockHash)) return 'confirmed';
    if (this.rejectedBlocks.has(blockHash)) return 'rejected';

    const tally = this.tallies.get(blockHash);
    if (!tally) return 'pending';

    // Check if this block has a conflict
    const conflictingHashes = this.getConflictingBlocks(blockHash);

    if (conflictingHashes.length === 0) {
      // No conflict — check threshold or grace period
      if (tally.totalStake > 0 && tally.approveStake / tally.totalStake >= CONFIRMATION_THRESHOLD) {
        this.confirmedBlocks.add(blockHash);
        return 'confirmed';
      }
      // Grace period: auto-confirm if uncontested for 10s (even with zero votes — bootstrap)
      if (Date.now() - tally.createdAt > AUTO_CONFIRM_GRACE_MS) {
        this.confirmedBlocks.add(blockHash);
        return 'confirmed';
      }
    } else {
      // Conflict exists — the block with more approve stake wins
      let myStake = tally.approveStake;
      let maxCompetitorStake = 0;
      let allCompetitorsVoted = true;

      for (const competitorHash of conflictingHashes) {
        const competitorTally = this.tallies.get(competitorHash);
        if (!competitorTally) { allCompetitorsVoted = false; continue; }
        if (competitorTally.approveStake > maxCompetitorStake) {
          maxCompetitorStake = competitorTally.approveStake;
        }
      }

      // If we have more stake AND meet threshold, we win
      if (myStake > maxCompetitorStake && tally.totalStake > 0 &&
          myStake / tally.totalStake >= CONFIRMATION_THRESHOLD) {
        this.confirmedBlocks.add(blockHash);
        // Reject all competitors
        for (const h of conflictingHashes) {
          this.rejectedBlocks.add(h);
        }
        return 'confirmed';
      }

      // Grace period conflict resolution: after 10s, highest stake wins
      if (allCompetitorsVoted && Date.now() - tally.createdAt > AUTO_CONFIRM_GRACE_MS) {
        if (myStake >= maxCompetitorStake && myStake > 0) {
          this.confirmedBlocks.add(blockHash);
          for (const h of conflictingHashes) {
            this.rejectedBlocks.add(h);
          }
          return 'confirmed';
        } else {
          this.rejectedBlocks.add(blockHash);
          return 'rejected';
        }
      }
    }

    return 'pending';
  }

  getTally(blockHash: string): VoteTally | undefined {
    return this.tallies.get(blockHash);
  }

  isConfirmed(blockHash: string): boolean {
    return this.getStatus(blockHash) === 'confirmed';
  }

  /** Get block hashes that conflict with the given block (same parent + same account) */
  private getConflictingBlocks(blockHash: string): string[] {
    for (const [, blockSet] of this.parentToBlocks) {
      if (blockSet.has(blockHash) && blockSet.size > 1) {
        return Array.from(blockSet).filter((h) => h !== blockHash);
      }
    }
    return [];
  }

  hasConflict(blockHash: string): boolean {
    return this.getConflictingBlocks(blockHash).length > 0;
  }

  /** Create a signed vote */
  static async createVote(
    blockHash: string,
    approve: boolean,
    stake: number,
    keys: KeyPair,
  ): Promise<Vote> {
    const timestamp = Date.now();
    const payload = `vote:${blockHash}:${approve}:${stake}:${timestamp}`;
    const signature = await signData(payload, keys);
    return {
      blockHash,
      voterPub: keys.pub,
      approve,
      stake,
      timestamp,
      signature,
    };
  }

  /** Verify a vote signature */
  static async verifyVote(vote: Vote): Promise<boolean> {
    const payload = `vote:${vote.blockHash}:${vote.approve}:${vote.stake}:${vote.timestamp}`;
    const result = await verifySignature(vote.signature, vote.voterPub);
    return result === payload;
  }

  /** Clear all data (for reset) */
  clear(): void {
    this.tallies.clear();
    this.confirmedBlocks.clear();
    this.rejectedBlocks.clear();
    this.parentToBlocks.clear();
  }
}
