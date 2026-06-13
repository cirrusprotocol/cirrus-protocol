// Local JSON persistence for the ZK indexer event log and replay state.
//
// This module is pure/local: no network, no RPC, no validator.
// Snapshots are written to / read from caller-provided file paths.
//
// Bigint fields (denomination, slot) are serialized as decimal strings so that
// standard JSON.stringify / JSON.parse handles them without loss of precision.

import * as fs from "fs";
import {
  NormalizedNoteDepositedEvent,
  normalizeNoteDepositedEvent,
  replayNoteDeposits,
} from "./event_log";
import { IncrementalMerkleTree } from "./incremental_tree";
import { TREE_DEPTH } from "./constants";

// ── Persisted types ──────────────────────────────────────────────────────────

export interface PersistedNoteDepositedEvent {
  commitment_be_hex: string;
  denomination: string; // decimal string — bigint cannot be JSON-serialized directly
  leaf_index: number;
  depositor: string;
  slot: string; // decimal string
  signature?: string;
  log_index?: number;
}

export interface SnapshotFetchMeta {
  fetch_commitment?: string;
  source_mode?: "exact-signature" | "address";
  rpc_url?: string;
  program_id?: string;
  address?: string;
  signature?: string;
  created_at?: string;
}

export interface PersistedIndexerSnapshot {
  version: number;
  tree_depth: number;
  events: PersistedNoteDepositedEvent[];
  last_root_be_hex: string;
  leaf_count: number;
  meta?: SnapshotFetchMeta;
}

// ── Conversion helpers ───────────────────────────────────────────────────────

export function serializeEvent(
  event: NormalizedNoteDepositedEvent
): PersistedNoteDepositedEvent {
  const persisted: PersistedNoteDepositedEvent = {
    commitment_be_hex: event.commitment_be_hex,
    denomination: event.denomination.toString(),
    leaf_index: event.leaf_index,
    depositor: event.depositor,
    slot: event.slot.toString(),
  };
  if (event.signature !== undefined) persisted.signature = event.signature;
  if (event.log_index !== undefined) persisted.log_index = event.log_index;
  return persisted;
}

export function deserializeEvent(
  persisted: PersistedNoteDepositedEvent
): NormalizedNoteDepositedEvent {
  // Route through normalizeNoteDepositedEvent so commitment format, leaf_index,
  // denomination, slot, depositor, and log_index all use the same validation rules
  // as live event ingestion.
  return normalizeNoteDepositedEvent({
    commitment: persisted.commitment_be_hex,
    denomination: persisted.denomination,
    leaf_index: persisted.leaf_index,
    depositor: persisted.depositor,
    slot: persisted.slot,
    signature: persisted.signature,
    log_index: persisted.log_index,
  });
}

// ── Snapshot API ─────────────────────────────────────────────────────────────

/**
 * Build a PersistedIndexerSnapshot from an ordered array of events.
 * Replays all events into a fresh tree to compute last_root_be_hex and leaf_count.
 * Requires initPoseidon() to have been called.
 * Does NOT sort; caller must provide events in replay order.
 * If meta is provided, emits version 2 and attaches fetch provenance. Without
 * meta, emits version 1 for backward compatibility with existing callers.
 */
export function buildSnapshot(
  events: NormalizedNoteDepositedEvent[],
  meta?: SnapshotFetchMeta
): PersistedIndexerSnapshot {
  const tree = new IncrementalMerkleTree();
  const result = replayNoteDeposits(tree, events);
  const snapshot: PersistedIndexerSnapshot = {
    version: meta !== undefined ? 2 : 1,
    tree_depth: TREE_DEPTH,
    events: events.map(serializeEvent),
    last_root_be_hex: result.root_be_hex,
    leaf_count: result.leaf_count,
  };
  if (meta !== undefined) snapshot.meta = meta;
  return snapshot;
}

/**
 * Serialize events to a snapshot and write to filePath as formatted JSON.
 * Requires initPoseidon() to have been called.
 */
export function saveSnapshot(
  filePath: string,
  events: NormalizedNoteDepositedEvent[],
  meta?: SnapshotFetchMeta
): void {
  const snapshot = buildSnapshot(events, meta);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
}

/**
 * Load a snapshot from filePath, deserialize events, and rebuild the tree.
 *
 * Safety checks (throw on failure):
 *   - invalid JSON
 *   - version !== 1 and version !== 2
 *   - tree_depth !== TREE_DEPTH
 *   - events is not an array
 *   - any event fails deserialization
 *   - any event is out of order (expectedLeafIndex mismatch during replay)
 *   - rebuilt root !== snapshot.last_root_be_hex
 *   - rebuilt leaf_count !== snapshot.leaf_count
 *
 * Requires initPoseidon() to have been called.
 */
export function loadSnapshot(filePath: string): {
  snapshot: PersistedIndexerSnapshot;
  events: NormalizedNoteDepositedEvent[];
  tree: IncrementalMerkleTree;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `loadSnapshot: cannot read file: ${(err as Error).message}`
    );
  }

  let snapshot: PersistedIndexerSnapshot;
  try {
    snapshot = JSON.parse(raw) as PersistedIndexerSnapshot;
  } catch (err) {
    throw new Error(`loadSnapshot: invalid JSON: ${(err as Error).message}`);
  }

  if (snapshot.version !== 1 && snapshot.version !== 2)
    throw new Error(
      `loadSnapshot: unsupported version ${snapshot.version}, expected 1 or 2`
    );
  if (snapshot.tree_depth !== TREE_DEPTH)
    throw new Error(
      `loadSnapshot: tree_depth mismatch: expected ${TREE_DEPTH}, got ${snapshot.tree_depth}`
    );
  if (!Array.isArray(snapshot.events))
    throw new Error("loadSnapshot: events is not an array");

  let events: NormalizedNoteDepositedEvent[];
  try {
    events = snapshot.events.map((e, i) => {
      try {
        return deserializeEvent(e);
      } catch (err) {
        throw new Error(`event at index ${i}: ${(err as Error).message}`);
      }
    });
  } catch (err) {
    throw new Error(
      `loadSnapshot: event deserialization failed: ${(err as Error).message}`
    );
  }

  // Replay events in stored order; any gap or out-of-order entry throws from tree.append.
  const tree = new IncrementalMerkleTree();
  const result = replayNoteDeposits(tree, events);

  if (result.root_be_hex !== snapshot.last_root_be_hex)
    throw new Error(
      `loadSnapshot: root mismatch: snapshot=${snapshot.last_root_be_hex} rebuilt=${result.root_be_hex}`
    );
  if (result.leaf_count !== snapshot.leaf_count)
    throw new Error(
      `loadSnapshot: leaf_count mismatch: snapshot=${snapshot.leaf_count} rebuilt=${result.leaf_count}`
    );

  return { snapshot, events, tree };
}
