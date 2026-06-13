// Read-only RPC adapter skeleton for the local ZK indexer.
//
// Bridges connection-like objects (real @solana/web3.js Connection or mocks)
// to the existing local log_parser / event_log pipeline.
//
// No RPC endpoint is created here; the caller supplies the connection.
// Tests use mocked connections only.
//
// Does NOT sort, replay, save snapshots, or submit roots. Those responsibilities
// remain with callers that already use event_log.ts and persistence.ts.

import { NormalizedNoteDepositedEvent } from "./event_log";
import {
  TransactionEventFixture,
  extractNoteDepositedEventsFromFixtures,
} from "./log_parser";

// ── Connection-like interfaces ────────────────────────────────────────────────

export interface SignatureInfoLike {
  signature: string;
  slot?: number;
  blockTime?: number | null;
  err?: unknown;
}

export interface TransactionLike {
  slot?: number;
  transaction?: unknown;
  meta?: {
    logMessages?: string[] | null;
    err?: unknown;
  } | null;
}

export interface ReadOnlyConnectionLike {
  getSignaturesForAddress(
    address: unknown,
    options?: { limit?: number; before?: string; until?: string },
    commitment?: string
  ): Promise<SignatureInfoLike[]>;

  getTransaction(
    signature: string,
    config?: { commitment?: string; maxSupportedTransactionVersion?: number }
  ): Promise<TransactionLike | null>;
}

// ── Intermediate type ─────────────────────────────────────────────────────────

export interface FetchedTransaction {
  signature: string;
  slot?: number;
  transaction: TransactionLike;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch confirmed signatures for a given address via the provided connection.
 * Validates that each returned item carries a non-empty string signature.
 * If options.limit is provided it must be a positive safe integer.
 */
export async function fetchSignaturesForAddress(
  connection: ReadOnlyConnectionLike,
  address: unknown,
  options?: {
    limit?: number;
    before?: string;
    until?: string;
    commitment?: string;
  }
): Promise<SignatureInfoLike[]> {
  const { limit, before, until, commitment } = options ?? {};

  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(
        "fetchSignaturesForAddress: limit must be a positive safe integer"
      );
    }
  }

  const results = await connection.getSignaturesForAddress(
    address,
    { limit, before, until },
    commitment
  );

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (typeof item.signature !== "string" || item.signature.length === 0) {
      throw new Error(
        `fetchSignaturesForAddress: malformed signature at index ${i}`
      );
    }
  }

  return results;
}

/**
 * Fetch transaction details for a list of signatures.
 * Accepts either string[] or SignatureInfoLike[].
 *
 * Null results are silently skipped.
 * Failed transactions (meta.err present and non-null) are skipped unless
 * options.includeFailed is true.
 * Input order is preserved for non-skipped transactions.
 * Default maxSupportedTransactionVersion is 0.
 */
export async function fetchTransactionsForSignatures(
  connection: ReadOnlyConnectionLike,
  signatures: SignatureInfoLike[] | string[],
  options?: {
    commitment?: string;
    maxSupportedTransactionVersion?: number;
    includeFailed?: boolean;
  }
): Promise<FetchedTransaction[]> {
  const commitment = options?.commitment;
  const maxSupportedTransactionVersion =
    options?.maxSupportedTransactionVersion ?? 0;
  const includeFailed = options?.includeFailed ?? false;

  const results: FetchedTransaction[] = [];

  for (const sig of signatures) {
    let sigStr: string;
    let inputSlot: number | undefined;

    if (typeof sig === "string") {
      sigStr = sig;
    } else {
      sigStr = sig.signature;
      inputSlot = sig.slot;
    }

    if (typeof sigStr !== "string" || sigStr.length === 0) {
      throw new Error("fetchTransactionsForSignatures: malformed signature");
    }

    const tx = await connection.getTransaction(sigStr, {
      commitment,
      maxSupportedTransactionVersion,
    });

    if (tx == null) continue;

    if (!includeFailed && tx.meta?.err != null) continue;

    results.push({
      signature: sigStr,
      slot: tx.slot ?? inputSlot,
      transaction: tx,
    });
  }

  return results;
}

/**
 * Convert a single fetched transaction to a TransactionEventFixture.
 * Extracts logMessages from meta; falls back to [] when absent or null.
 * Uses transaction.slot first, then input.slot as fallback.
 */
export function transactionToEventFixture(
  input: FetchedTransaction
): TransactionEventFixture {
  const logMessages: string[] =
    (input.transaction.meta?.logMessages as string[] | null | undefined) ?? [];
  return {
    signature: input.signature,
    slot: input.transaction.slot ?? input.slot,
    logs: logMessages,
  };
}

/**
 * Convert an array of fetched transactions to TransactionEventFixtures.
 * Preserves input order.
 */
export function transactionsToEventFixtures(
  inputs: FetchedTransaction[]
): TransactionEventFixture[] {
  return inputs.map(transactionToEventFixture);
}

/**
 * Extract normalized NoteDeposited events from fetched transactions.
 * Converts to fixtures and delegates to extractNoteDepositedEventsFromFixtures.
 * Does NOT sort, replay, or save snapshots.
 */
export function extractNoteDepositedEventsFromTransactions(
  inputs: FetchedTransaction[]
): NormalizedNoteDepositedEvent[] {
  return extractNoteDepositedEventsFromFixtures(
    transactionsToEventFixtures(inputs)
  );
}

/**
 * Fetch signatures for an address, fetch the corresponding transactions, and
 * extract normalized NoteDeposited events in one call.
 *
 * Does NOT sort, replay, save snapshots, or submit roots.
 * The caller is responsible for sorting and replaying via event_log.ts.
 */
export async function fetchAndExtractNoteDepositedEvents(
  connection: ReadOnlyConnectionLike,
  address: unknown,
  options?: {
    limit?: number;
    before?: string;
    until?: string;
    commitment?: string;
    maxSupportedTransactionVersion?: number;
    includeFailed?: boolean;
  }
): Promise<NormalizedNoteDepositedEvent[]> {
  const sigs = await fetchSignaturesForAddress(connection, address, {
    limit: options?.limit,
    before: options?.before,
    until: options?.until,
    commitment: options?.commitment,
  });

  const txs = await fetchTransactionsForSignatures(connection, sigs, {
    commitment: options?.commitment,
    maxSupportedTransactionVersion: options?.maxSupportedTransactionVersion,
    includeFailed: options?.includeFailed,
  });

  return extractNoteDepositedEventsFromTransactions(txs);
}
