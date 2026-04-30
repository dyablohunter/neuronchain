/**
 * Epoch snapshots for blockchain bootstrapping (A8).
 *
 * When the local blockchain exceeds SNAPSHOT_TRIGGER_BYTES (1 GB), a node
 * creates a compressed snapshot of all confirmed accounts and blocks, stores
 * it as a content CID in the SmokeStore, and broadcasts the CID to peers.
 *
 * New nodes can download a snapshot CID and import it, skipping the replay
 * of the full block history and going straight to a confirmed ledger state.
 *
 * Snapshot format (gzip-compressed JSON):
 *   { version, createdAt, network, epochBlock, accounts: Account[], blocks: AccountBlock[] }
 */

import { AccountBlock } from './dag-block';
import { Account } from './account';

export const SNAPSHOT_TRIGGER_BYTES = 1_073_741_824; // 1 GB
export const SNAPSHOT_VERSION = 1;

export interface LedgerSnapshot {
  version: number;
  createdAt: number;
  network: string;
  /** Hash of the latest block included in this snapshot - acts as a checkpoint. */
  epochBlock: string;
  accounts: Account[];
  blocks: AccountBlock[];
}

// ── Serialise + compress ──────────────────────────────────────────────────────

export async function createSnapshot(
  network: string,
  accounts: Account[],
  blocks: AccountBlock[],
  epochBlock: string,
): Promise<Uint8Array> {
  const snapshot: LedgerSnapshot = {
    version: SNAPSHOT_VERSION,
    createdAt: Date.now(),
    network,
    epochBlock,
    accounts,
    blocks,
  };

  const json = JSON.stringify(snapshot);
  const encoded = new TextEncoder().encode(json);

  if (typeof CompressionStream === 'undefined') return encoded;

  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(encoded);
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

// ── Decompress + deserialise ──────────────────────────────────────────────────

export async function parseSnapshot(data: Uint8Array): Promise<LedgerSnapshot | null> {
  try {
    let json: string;

    if (typeof DecompressionStream !== 'undefined' && data[0] === 0x1f && data[1] === 0x8b) {
      // gzip magic bytes - decompress
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(data as unknown as BufferSource);
      writer.close();

      const chunks: Uint8Array[] = [];
      const reader = ds.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array);
      }

      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const raw = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { raw.set(c, off); off += c.byteLength; }
      json = new TextDecoder().decode(raw);
    } else {
      json = new TextDecoder().decode(data);
    }

    const snap = JSON.parse(json) as LedgerSnapshot;
    if (snap.version !== SNAPSHOT_VERSION) return null;
    if (!snap.network || !Array.isArray(snap.accounts) || !Array.isArray(snap.blocks)) return null;
    return snap;
  } catch {
    return null;
  }
}

// ── CID helper (SHA-256 of raw bytes) ────────────────────────────────────────

export async function snapshotCid(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] >> 4).toString(16) + (bytes[i] & 0xf).toString(16);
  return `snapshot-${hex}`;
}
