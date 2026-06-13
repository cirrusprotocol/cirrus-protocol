#!/usr/bin/env ts-node
// Read-only RPC indexer CLI wrapper for the local ZK indexer.
//
// Fetches transactions for a program/address through a supplied RPC URL,
// extracts NoteDeposited events via the configured decoder pipeline,
// optionally sorts them, and writes a JSON snapshot.
//
// Decoder modes:
//   event-json           — default; parses EVENT_JSON-marked log lines
//   anchor-event-parser  — decodes Anchor base64 events using @anchor-lang/core
//
// Fetch modes:
//   address mode         — default; uses getSignaturesForAddress (with optional
//                          --limit, --before, --until pagination). --address required.
//   signature mode       — --signature <sig>; fetches exactly one transaction by
//                          signature using getTransaction. Does not call
//                          getSignaturesForAddress. --address is not required.
//                          --limit, --before, and --until are rejected.
//
// In normal write mode, the written snapshot is immediately reloaded with
// loadSnapshot and verified (root + leaf_count + tree root) before the CLI
// reports success.
//
// --dry-run skips the write entirely: fetch, decode, sort, and build the
// snapshot in memory, then return summary fields without touching disk.
//
// No transactions are sent. No roots are submitted. No keypairs are created.
// @solana/web3.js Connection and PublicKey are loaded only in the CLI entry
// path; this module can be safely imported in tests without a live connection.

import * as fs from "fs";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import {
  NormalizedNoteDepositedEvent,
  sortEventsForReplay,
} from "../lib/zk_indexer/event_log";
import {
  buildSnapshot,
  loadSnapshot,
  SnapshotFetchMeta,
} from "../lib/zk_indexer/persistence";
import {
  ReadOnlyConnectionLike,
  FetchedTransaction,
  fetchSignaturesForAddress,
  fetchTransactionsForSignatures,
  extractNoteDepositedEventsFromTransactions,
} from "../lib/zk_indexer/rpc_adapter";
import { createAnchorEventParserLogDecoderFromIdl } from "../lib/zk_indexer/anchor_event_parser_adapter";
import { extractNoteDepositedEventsFromDecodedEvents } from "../lib/zk_indexer/event_decoder";

// ── Helpers ───────────────────────────────────────────────────────────────────

export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    return u.toString();
  } catch {
    return "[invalid-url]";
  }
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface RpcIndexerArgs {
  rpcUrl: string;
  address?: string;
  signature?: string;
  outputPath: string;
  limit?: number;
  before?: string;
  until?: string;
  commitment?: string;
  includeFailed: boolean;
  sort: boolean;
  decoder: "event-json" | "anchor-event-parser";
  idlPath?: string;
  programId?: string;
  dryRun: boolean;
}

export interface RpcIndexerDeps {
  connection: ReadOnlyConnectionLike;
  address?: unknown;
}

export interface RpcIndexerResult {
  extracted: number;
  sorted: boolean;
  leaf_count: number;
  root_be_hex: string;
  outputPath: string;
  dryRun: boolean;
  wroteSnapshot: boolean;
  verifiedSnapshot: boolean;
  meta: SnapshotFetchMeta;
  snapshotVersion: number;
}

// ── CLI help ──────────────────────────────────────────────────────────────────

export function isHelpRequested(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export function usageText(): string {
  return `Usage: npx ts-node scripts/zk_indexer_rpc_fetch.ts [flags]

Read-only ZK indexer RPC fetch CLI. Fetches transactions via a supplied RPC
URL, extracts NoteDeposited events, builds a local Merkle snapshot, and
optionally writes and verifies it on disk.

No transactions sent. No roots submitted. No keypairs required.

Decoder modes:
  event-json (default)   Parse EVENT_JSON:-marked log lines.
  anchor-event-parser    Decode Anchor base64 events via @anchor-lang/core.
                         Requires --idl and --program-id.

Fetch modes:
  address mode (default) Fetch signatures via getSignaturesForAddress, then
                         retrieve each transaction. --address is required.
                         Supports --limit, --before, --until pagination.
  signature mode         Fetch exactly one transaction by --signature <sig>
                         via getTransaction. --address, --limit, --before,
                         and --until are all rejected. Use for reproducible
                         exact-transaction smoke tests.

Write behavior:
  Default                Writes snapshot to --output; reloads with loadSnapshot
                         and verifies root/leaf_count consistency.
  --dry-run              Builds snapshot in memory only; skips disk write.

Required (address mode):
  --rpc-url <url>        RPC endpoint URL
  --address <pubkey>     Account or program address to query
  --output <path>        Output snapshot path (required even with --dry-run)

Required (signature mode):
  --rpc-url <url>        RPC endpoint URL
  --signature <sig>      Exact transaction signature to fetch
  --output <path>        Output snapshot path (required even with --dry-run)

Optional:
  --limit <n>            Max signatures to fetch (address mode only)
  --before <sig>         Fetch signatures before this cursor (address mode only)
  --until <sig>          Stop at this signature cursor (address mode only)
  --commitment <level>   Commitment level (e.g. confirmed, finalized)
  --decoder <mode>       event-json (default) or anchor-event-parser
  --idl <path>           IDL JSON path (required for --decoder anchor-event-parser)
  --program-id <pubkey>  Program ID for EventParser (required for anchor-event-parser)
  --include-failed       Include logs from failed transactions
  --no-sort              Preserve fetch order (fails on out-of-order events)
  --dry-run              Build snapshot in memory only; do not write to --output
  --help, -h             Print this help text and exit

Examples:

  # event-json dry run (address mode):
  npx ts-node scripts/zk_indexer_rpc_fetch.ts \\
    --rpc-url https://api.devnet.solana.com \\
    --address <PROGRAM_OR_ACCOUNT_PUBKEY> \\
    --output /tmp/snapshot.json \\
    --limit 10 --commitment confirmed --dry-run

  # anchor-event-parser dry run (address mode):
  npx ts-node scripts/zk_indexer_rpc_fetch.ts \\
    --rpc-url https://api.devnet.solana.com \\
    --address <PROGRAM_OR_ACCOUNT_PUBKEY> \\
    --program-id <PROGRAM_ID> \\
    --idl idl/shielded_pool_anchor.json \\
    --decoder anchor-event-parser \\
    --output /tmp/snapshot.json \\
    --limit 10 --commitment confirmed --dry-run

  # anchor-event-parser exact-signature dry run (reproducible positive smoke):
  npx ts-node scripts/zk_indexer_rpc_fetch.ts \\
    --rpc-url https://api.devnet.solana.com \\
    --signature <TX_SIGNATURE> \\
    --program-id <PROGRAM_ID> \\
    --idl idl/shielded_pool_anchor.json \\
    --decoder anchor-event-parser \\
    --output /tmp/snapshot.json \\
    --commitment confirmed --dry-run
`;
}

// ── Core (exported for tests) ─────────────────────────────────────────────────

export async function runRpcIndexer(
  args: RpcIndexerArgs,
  deps: RpcIndexerDeps
): Promise<RpcIndexerResult> {
  await initPoseidon();

  // Step 1: Fetch transactions — exact-signature mode or address mode.
  let txs: FetchedTransaction[];

  if (args.signature !== undefined) {
    // Exact-signature mode: fetch the single known transaction directly.
    // getSignaturesForAddress is never called in this path.
    const rawTx = await deps.connection.getTransaction(args.signature, {
      commitment: args.commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (rawTx === null) {
      throw new Error(`transaction not found: ${args.signature}`);
    }
    const isFailed = rawTx.meta?.err != null;
    txs =
      !isFailed || args.includeFailed
        ? [{ signature: args.signature, slot: rawTx.slot, transaction: rawTx }]
        : [];
  } else {
    // Address mode: getSignaturesForAddress + getTransaction for each sig.
    if (deps.address === undefined) {
      throw new Error(
        "runRpcIndexer: address dependency is required in address mode"
      );
    }
    const sigs = await fetchSignaturesForAddress(
      deps.connection,
      deps.address,
      {
        limit: args.limit,
        before: args.before,
        until: args.until,
        commitment: args.commitment,
      }
    );
    txs = await fetchTransactionsForSignatures(deps.connection, sigs, {
      commitment: args.commitment,
      includeFailed: args.includeFailed,
    });
  }

  // Step 2: Decode events from fetched transactions.
  let events: NormalizedNoteDepositedEvent[];

  if (args.decoder === "anchor-event-parser") {
    if (args.idlPath === undefined) {
      throw new Error("runRpcIndexer: anchor-event-parser requires idlPath");
    }
    if (args.programId === undefined) {
      throw new Error("runRpcIndexer: anchor-event-parser requires programId");
    }

    let rawIdl: string;
    try {
      rawIdl = fs.readFileSync(args.idlPath, "utf-8");
    } catch (err) {
      throw new Error(
        `cannot read IDL file ${args.idlPath}: ${(err as Error).message}`
      );
    }

    let idl: unknown;
    try {
      idl = JSON.parse(rawIdl);
    } catch (err) {
      throw new Error(
        `invalid IDL JSON in ${args.idlPath}: ${(err as Error).message}`
      );
    }

    const decoder = createAnchorEventParserLogDecoderFromIdl({
      programId: args.programId,
      idl,
    });

    events = [];
    for (const tx of txs) {
      const logs =
        (tx.transaction.meta?.logMessages as string[] | null | undefined) ?? [];
      const decoded = decoder.decodeLogs({
        logs,
        signature: tx.signature,
        slot: tx.slot !== undefined ? BigInt(tx.slot) : undefined,
      });
      events.push(...extractNoteDepositedEventsFromDecodedEvents(decoded));
    }
  } else {
    events = extractNoteDepositedEventsFromTransactions(txs);
  }

  // Step 3: Sort, build snapshot, optionally write and verify.
  const ordered = args.sort ? sortEventsForReplay(events) : events;
  const meta: SnapshotFetchMeta = {
    fetch_commitment: args.commitment,
    source_mode: args.signature !== undefined ? "exact-signature" : "address",
    rpc_url: redactRpcUrl(args.rpcUrl),
    program_id: args.programId,
    address: args.signature !== undefined ? undefined : args.address,
    signature: args.signature,
    created_at: new Date().toISOString(),
  };
  const snapshot = buildSnapshot(ordered, meta);

  let wroteSnapshot = false;
  let verifiedSnapshot = false;

  if (!args.dryRun) {
    try {
      fs.writeFileSync(
        args.outputPath,
        JSON.stringify(snapshot, null, 2),
        "utf-8"
      );
    } catch (err) {
      throw new Error(
        `runRpcIndexer: failed to write snapshot: ${(err as Error).message}`
      );
    }
    wroteSnapshot = true;

    try {
      const loaded = loadSnapshot(args.outputPath);
      if (loaded.snapshot.last_root_be_hex !== snapshot.last_root_be_hex) {
        throw new Error("root mismatch after reload");
      }
      if (loaded.snapshot.leaf_count !== snapshot.leaf_count) {
        throw new Error("leaf_count mismatch after reload");
      }
      if (loaded.tree.getRoot() !== snapshot.last_root_be_hex) {
        throw new Error("tree root mismatch after reload");
      }
    } catch (err) {
      throw new Error(
        `runRpcIndexer: written snapshot verification failed: ${
          (err as Error).message
        }`
      );
    }
    verifiedSnapshot = true;
  }

  return {
    extracted: events.length,
    sorted: args.sort,
    leaf_count: snapshot.leaf_count,
    root_be_hex: snapshot.last_root_be_hex,
    outputPath: args.outputPath,
    dryRun: args.dryRun,
    wroteSnapshot,
    verifiedSnapshot,
    meta,
    snapshotVersion: snapshot.version,
  };
}

// ── CLI argument parser (exported for tests) ─────────────────────────────────

export function parseArgs(argv: string[]): RpcIndexerArgs {
  const VALUED_FLAGS = new Set([
    "--rpc-url",
    "--address",
    "--signature",
    "--output",
    "--limit",
    "--before",
    "--until",
    "--commitment",
    "--decoder",
    "--idl",
    "--program-id",
  ]);
  const BOOL_FLAGS = new Set(["--include-failed", "--no-sort", "--dry-run"]);

  let rpcUrl: string | undefined;
  let address: string | undefined;
  let signature: string | undefined;
  let outputPath: string | undefined;
  let limit: number | undefined;
  let before: string | undefined;
  let until: string | undefined;
  let commitment: string | undefined;
  let includeFailed = false;
  let sort = true;
  let dryRun = false;
  let decoderRaw = "event-json";
  let idlPath: string | undefined;
  let programId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];

    if (VALUED_FLAGS.has(flag)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        throw new Error(`parseArgs: missing value after ${flag}`);
      }
      const value = argv[++i];
      switch (flag) {
        case "--rpc-url":
          rpcUrl = value;
          break;
        case "--address":
          address = value;
          break;
        case "--signature":
          signature = value;
          break;
        case "--output":
          outputPath = value;
          break;
        case "--before":
          before = value;
          break;
        case "--until":
          until = value;
          break;
        case "--commitment":
          commitment = value;
          break;
        case "--decoder":
          decoderRaw = value;
          break;
        case "--idl":
          idlPath = value;
          break;
        case "--program-id":
          programId = value;
          break;
        case "--limit": {
          const n = Number(value);
          if (!Number.isSafeInteger(n) || n <= 0) {
            throw new Error(
              `parseArgs: --limit must be a positive safe integer, got: ${value}`
            );
          }
          limit = n;
          break;
        }
      }
    } else if (BOOL_FLAGS.has(flag)) {
      if (flag === "--include-failed") includeFailed = true;
      else if (flag === "--dry-run") dryRun = true;
      else sort = false;
    } else {
      throw new Error(`parseArgs: unknown flag: ${flag}`);
    }
  }

  if (rpcUrl === undefined) throw new Error("parseArgs: --rpc-url is required");
  if (outputPath === undefined)
    throw new Error("parseArgs: --output is required");

  if (signature !== undefined) {
    // Exact-signature mode: --address, --limit, --before, and --until are all
    // address-mode flags and are rejected to avoid ambiguity. The transaction
    // is identified solely by its signature; no address filter is applied.
    if (address !== undefined) {
      throw new Error(
        "parseArgs: --signature is mutually exclusive with --address"
      );
    }
    if (limit !== undefined) {
      throw new Error(
        "parseArgs: --signature is mutually exclusive with --limit"
      );
    }
    if (before !== undefined) {
      throw new Error(
        "parseArgs: --signature is mutually exclusive with --before"
      );
    }
    if (until !== undefined) {
      throw new Error(
        "parseArgs: --signature is mutually exclusive with --until"
      );
    }
  } else {
    // Address mode: --address is required.
    if (address === undefined)
      throw new Error("parseArgs: --address is required");
  }

  if (decoderRaw !== "event-json" && decoderRaw !== "anchor-event-parser") {
    throw new Error(
      `parseArgs: unknown --decoder value: ${decoderRaw}; expected event-json or anchor-event-parser`
    );
  }

  const decoder = decoderRaw as "event-json" | "anchor-event-parser";

  if (decoder === "anchor-event-parser") {
    if (idlPath === undefined) {
      throw new Error(
        "parseArgs: --decoder anchor-event-parser requires --idl"
      );
    }
    if (programId === undefined) {
      throw new Error(
        "parseArgs: --decoder anchor-event-parser requires --program-id"
      );
    }
  }

  return {
    rpcUrl,
    address,
    signature,
    outputPath,
    limit,
    before,
    until,
    commitment,
    includeFailed,
    sort,
    dryRun,
    decoder,
    idlPath,
    programId,
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    if (isHelpRequested(argv)) {
      console.log(usageText());
      process.exit(0);
    }

    let args: RpcIndexerArgs;
    try {
      args = parseArgs(argv);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    let connection: ReadOnlyConnectionLike;
    let pubkey: unknown;
    try {
      // @solana/web3.js is required only here so that importing this module in
      // tests does not instantiate a real connection or load the full library.
      const { Connection, PublicKey } = require("@solana/web3.js") as {
        Connection: new (
          endpoint: string,
          commitment?: string
        ) => ReadOnlyConnectionLike;
        PublicKey: new (value: string) => unknown;
      };
      connection = new Connection(
        args!.rpcUrl,
        args!.commitment ?? "confirmed"
      );
      pubkey =
        args!.address !== undefined ? new PublicKey(args!.address) : undefined;
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }

    try {
      const result = await runRpcIndexer(args!, {
        connection: connection!,
        address: pubkey,
      });
      console.log(`extracted:        ${result.extracted}`);
      console.log(`sorted:           ${result.sorted}`);
      console.log(`snapshot_version: ${result.snapshotVersion}`);
      console.log(
        `fetch_commitment: ${result.meta.fetch_commitment ?? "(none)"}`
      );
      console.log(`source_mode:      ${result.meta.source_mode}`);
      console.log(`program_id:       ${result.meta.program_id ?? "(none)"}`);
      console.log(`leaf_count:       ${result.leaf_count}`);
      console.log(`root:             ${result.root_be_hex}`);
      console.log(`dry_run:          ${result.dryRun}`);
      console.log(`wrote:            ${result.wroteSnapshot}`);
      console.log(`verified:         ${result.verifiedSnapshot}`);
      console.log(`output:           ${result.outputPath}`);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
  })();
}
