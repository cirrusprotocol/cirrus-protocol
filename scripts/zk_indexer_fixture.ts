#!/usr/bin/env ts-node
/**
 * ZK Indexer Fixture Runner
 *
 * Reads a local JSON file of raw NoteDeposited-like event objects, normalises
 * them, replays into an IncrementalMerkleTree, and writes a snapshot JSON.
 * No network, no RPC, no validator required.
 *
 * Usage:
 *   npx ts-node scripts/zk_indexer_fixture.ts --input /tmp/events.json --output /tmp/snapshot.json
 *   npx ts-node scripts/zk_indexer_fixture.ts --input /tmp/events.json --output /tmp/snapshot.json --no-sort
 *
 * Input JSON formats accepted:
 *   Bare array:      [ { "commitment": "...", ... }, ... ]
 *   Object wrapper:  { "events": [ { "commitment": "...", ... }, ... ] }
 *
 * Flags:
 *   --input <path>   Path to input JSON file  (required)
 *   --output <path>  Path to output snapshot  (required)
 *   --no-sort        Skip sortEventsForReplay; events are replayed as-is
 */

import * as fs from "fs";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import {
  NormalizedNoteDepositedEvent,
  normalizeNoteDepositedEvent,
  sortEventsForReplay,
} from "../lib/zk_indexer/event_log";
import { buildSnapshot } from "../lib/zk_indexer/persistence";

// ── Public types ─────────────────────────────────────────────────────────────

export interface FixtureResult {
  inserted: number;
  leaf_count: number;
  root_be_hex: string;
  outputPath: string;
}

export interface ParsedArgs {
  inputPath: string;
  outputPath: string;
  sort: boolean;
}

// ── Core logic (exported for tests) ─────────────────────────────────────────

/**
 * Read events from inputPath, normalise, optionally sort, replay into a fresh
 * tree, and write a snapshot to outputPath.
 *
 * @param args.sort  Default true.  Pass false to skip sortEventsForReplay.
 */
export async function runFixtureIndexer(args: {
  inputPath: string;
  outputPath: string;
  sort?: boolean;
}): Promise<FixtureResult> {
  const sort = args.sort !== false; // undefined → true

  // ── Read ──────────────────────────────────────────────────────────────────
  let rawText: string;
  try {
    rawText = fs.readFileSync(args.inputPath, "utf-8");
  } catch (err) {
    throw new Error(
      `runFixtureIndexer: cannot read input file: ${(err as Error).message}`
    );
  }

  // ── Parse JSON ────────────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `runFixtureIndexer: invalid JSON: ${(err as Error).message}`
    );
  }

  // ── Extract events array ──────────────────────────────────────────────────
  let rawEvents: unknown[];
  if (Array.isArray(parsed)) {
    rawEvents = parsed;
  } else if (
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>)["events"])
  ) {
    rawEvents = (parsed as Record<string, unknown>)["events"] as unknown[];
  } else {
    throw new Error(
      "runFixtureIndexer: input must be a JSON array or an object with an 'events' array"
    );
  }

  // ── Normalise ─────────────────────────────────────────────────────────────
  const normalized: NormalizedNoteDepositedEvent[] = rawEvents.map((raw, i) => {
    try {
      return normalizeNoteDepositedEvent(raw);
    } catch (err) {
      throw new Error(
        `runFixtureIndexer: event at index ${i}: ${(err as Error).message}`
      );
    }
  });

  // ── Sort or preserve order ────────────────────────────────────────────────
  const ordered = sort ? sortEventsForReplay(normalized) : normalized;

  // ── Replay and write snapshot ─────────────────────────────────────────────
  await initPoseidon();
  const snapshot = buildSnapshot(ordered);
  fs.writeFileSync(args.outputPath, JSON.stringify(snapshot, null, 2), "utf-8");

  return {
    inserted: ordered.length,
    leaf_count: snapshot.leaf_count,
    root_be_hex: snapshot.last_root_be_hex,
    outputPath: args.outputPath,
  };
}

// ── CLI argument parser (exported for tests) ─────────────────────────────────

export function parseArgs(argv: string[]): ParsedArgs {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let sort = true;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input" && i + 1 < argv.length) {
      inputPath = argv[++i];
    } else if (argv[i] === "--output" && i + 1 < argv.length) {
      outputPath = argv[++i];
    } else if (argv[i] === "--no-sort") {
      sort = false;
    }
  }

  if (inputPath === undefined)
    throw new Error("parseArgs: --input <path> is required");
  if (outputPath === undefined)
    throw new Error("parseArgs: --output <path> is required");

  return { inputPath, outputPath, sort };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    let args: ParsedArgs;
    try {
      args = parseArgs(process.argv.slice(2));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    try {
      const result = await runFixtureIndexer(args!);
      console.log(`inserted:    ${result.inserted}`);
      console.log(`leaf_count:  ${result.leaf_count}`);
      console.log(`root:        ${result.root_be_hex}`);
      console.log(`output:      ${result.outputPath}`);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exit(1);
    }
  })();
}
