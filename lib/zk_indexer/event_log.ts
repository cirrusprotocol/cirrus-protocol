// Local event normalization and replay layer for NoteDeposited events.
//
// This module is pure/local: no RPC calls, no persistence, no validator required.
// It normalises raw Anchor event data into a canonical in-memory representation
// and provides a replay function that feeds events into an IncrementalMerkleTree.

import { IncrementalMerkleTree } from "./incremental_tree";

// ── Types ────────────────────────────────────────────────────────────────────

export interface NormalizedNoteDepositedEvent {
  commitment_be_hex: string; // 64-char lowercase hex, 32-byte BE, no 0x
  denomination: bigint;
  leaf_index: number; // safe non-negative integer
  depositor: string; // base58 or string representation
  slot: bigint;
  signature?: string; // tx signature — replay cursor metadata
  log_index?: number; // position within tx logs — tiebreak metadata
}

// ── Private normalisation helpers ────────────────────────────────────────────

function normalizeCommitment(val: unknown): string {
  if (val === undefined || val === null)
    throw new Error("normalizeNoteDepositedEvent: missing commitment");

  if (Array.isArray(val)) {
    // Validate every element before Buffer.from() to prevent silent coercion
    // of out-of-range values (256, -1, 1.5, NaN).
    for (let i = 0; i < val.length; i++) {
      const x = val[i];
      if (!Number.isInteger(x) || x < 0 || x > 255)
        throw new Error(
          `normalizeNoteDepositedEvent: invalid commitment byte at index ${i}: ${x}`
        );
    }
    if (val.length !== 32)
      throw new Error(
        `normalizeNoteDepositedEvent: commitment wrong length: expected 32 bytes, got ${val.length}`
      );
    return Buffer.from(val).toString("hex");
  }

  if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
    const buf = Buffer.isBuffer(val) ? val : Buffer.from(val);
    if (buf.length !== 32)
      throw new Error(
        `normalizeNoteDepositedEvent: commitment wrong length: expected 32 bytes, got ${buf.length}`
      );
    return buf.toString("hex"); // lowercase
  }

  if (typeof val === "string") {
    if (val.startsWith("0x") || val.startsWith("0X"))
      throw new Error(
        "normalizeNoteDepositedEvent: commitment must not have 0x prefix"
      );
    if (val.length !== 64)
      throw new Error(
        `normalizeNoteDepositedEvent: commitment wrong length: expected 64 hex chars, got ${val.length}`
      );
    if (!/^[0-9a-fA-F]{64}$/.test(val))
      throw new Error(
        "normalizeNoteDepositedEvent: commitment contains non-hex characters"
      );
    return val.toLowerCase();
  }

  throw new Error(
    "normalizeNoteDepositedEvent: commitment must be Buffer, Uint8Array, number[], or hex string"
  );
}

function toBigInt(val: unknown, fieldName: string): bigint {
  if (val === undefined || val === null)
    throw new Error(`normalizeNoteDepositedEvent: missing ${fieldName}`);
  if (typeof val === "bigint") return val;
  if (typeof val === "number") return BigInt(val);
  if (typeof val === "string") return BigInt(val);
  // BN-like: any object with a toString() method (covers Anchor BN, etc.)
  if (
    typeof val === "object" &&
    typeof (val as { toString(): string }).toString === "function"
  )
    return BigInt((val as { toString(): string }).toString());
  throw new Error(
    `normalizeNoteDepositedEvent: cannot convert ${fieldName} to bigint`
  );
}

function toLeafIndex(val: unknown): number {
  if (val === undefined || val === null)
    throw new Error("normalizeNoteDepositedEvent: missing leaf_index");

  let n: number;
  if (typeof val === "number") {
    n = val;
  } else if (typeof val === "bigint") {
    n = Number(val);
  } else if (typeof val === "string") {
    n = Number(val);
  } else if (
    typeof val === "object" &&
    typeof (val as { toString(): string }).toString === "function"
  ) {
    n = Number((val as { toString(): string }).toString());
  } else {
    throw new Error(
      "normalizeNoteDepositedEvent: cannot convert leaf_index to number"
    );
  }

  if (!Number.isInteger(n))
    throw new Error(
      "normalizeNoteDepositedEvent: leaf_index must be an integer"
    );
  if (n < 0)
    throw new Error(
      "normalizeNoteDepositedEvent: leaf_index must be non-negative"
    );
  if (!Number.isSafeInteger(n))
    throw new Error(
      "normalizeNoteDepositedEvent: leaf_index exceeds safe integer range"
    );
  return n;
}

function toDepositor(val: unknown): string {
  if (val === undefined || val === null)
    throw new Error("normalizeNoteDepositedEvent: missing depositor");
  if (typeof val === "string") return val;
  // PublicKey-like: has toBase58() (Solana web3.js PublicKey)
  if (
    typeof val === "object" &&
    typeof (val as { toBase58(): string }).toBase58 === "function"
  )
    return (val as { toBase58(): string }).toBase58();
  // Fallback: any object with toString()
  if (
    typeof val === "object" &&
    typeof (val as { toString(): string }).toString === "function"
  )
    return (val as { toString(): string }).toString();
  throw new Error(
    "normalizeNoteDepositedEvent: cannot convert depositor to string"
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Normalise a raw Anchor NoteDeposited event payload into a canonical
 * NormalizedNoteDepositedEvent. Accepts the following input shapes:
 *
 *   commitment  — Buffer | Uint8Array | number[] | hex string (no 0x)
 *   denomination — BN | bigint | number | string
 *   leafIndex or leaf_index — BN | bigint | number | string
 *   depositor   — PublicKey (toBase58) | string
 *   slot        — BN | bigint | number | string
 *
 * Throws descriptively for any missing or malformed field.
 */
export function normalizeNoteDepositedEvent(
  raw: unknown
): NormalizedNoteDepositedEvent {
  if (raw === null || raw === undefined || typeof raw !== "object")
    throw new Error("normalizeNoteDepositedEvent: raw must be an object");

  const obj = raw as Record<string, unknown>;

  const commitment_be_hex = normalizeCommitment(obj["commitment"]);
  const denomination = toBigInt(obj["denomination"], "denomination");
  if (denomination < 0n)
    throw new Error(
      "normalizeNoteDepositedEvent: denomination must be non-negative"
    );

  // Accept Anchor's camelCase leafIndex or explicit snake_case leaf_index.
  const rawLeafIndex =
    obj["leafIndex"] !== undefined ? obj["leafIndex"] : obj["leaf_index"];
  const leaf_index = toLeafIndex(rawLeafIndex);

  const depositor = toDepositor(obj["depositor"]);

  const slot = toBigInt(obj["slot"], "slot");
  if (slot < 0n)
    throw new Error("normalizeNoteDepositedEvent: slot must be non-negative");

  const result: NormalizedNoteDepositedEvent = {
    commitment_be_hex,
    denomination,
    leaf_index,
    depositor,
    slot,
  };

  if (obj["signature"] !== undefined && obj["signature"] !== null)
    result.signature = String(obj["signature"]);

  if (obj["log_index"] !== undefined && obj["log_index"] !== null) {
    const li = Number(obj["log_index"]);
    if (!Number.isSafeInteger(li) || li < 0)
      throw new Error(
        `normalizeNoteDepositedEvent: invalid log_index: ${obj["log_index"]}`
      );
    result.log_index = li;
  }

  return result;
}

/**
 * Return a new sorted copy of events.
 *   Primary:    leaf_index ascending
 *   Secondary:  slot ascending
 *   Tertiary:   log_index ascending (missing log_index treated as 0)
 *
 * Does NOT mutate the input array.
 * replayNoteDeposits does NOT sort; callers must sort first when needed.
 */
export function sortEventsForReplay(
  events: NormalizedNoteDepositedEvent[]
): NormalizedNoteDepositedEvent[] {
  return [...events].sort((a, b) => {
    if (a.leaf_index !== b.leaf_index) return a.leaf_index - b.leaf_index;
    if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
    return (a.log_index ?? 0) - (b.log_index ?? 0);
  });
}

/**
 * Feed a pre-ordered array of normalised events into the tree in the order
 * provided. Does NOT sort; call sortEventsForReplay first if needed.
 *
 * Each event's leaf_index is passed as expectedLeafIndex to tree.append(),
 * so any gap or out-of-order event throws immediately.
 *
 * Returns inserted count, final root, and final leaf_count.
 */
export function replayNoteDeposits(
  tree: IncrementalMerkleTree,
  events: NormalizedNoteDepositedEvent[]
): { inserted: number; root_be_hex: string; leaf_count: number } {
  for (const event of events) {
    tree.append(event.commitment_be_hex, event.leaf_index);
  }
  return {
    inserted: events.length,
    root_be_hex: tree.getRoot(),
    leaf_count: tree.getLeafCount(),
  };
}
