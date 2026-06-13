#!/usr/bin/env ts-node
/**
 * Read-only snapshot hygiene report CLI.
 *
 * Reads a local indexer snapshot JSON, counts leaves, tallies denomination
 * buckets, and emits conservative diagnostic warnings.
 *
 * No RPC. No secrets. No witnesses. No proof artifacts. No keypairs.
 *
 * This report is not a privacy guarantee. No warning does not mean private.
 * Leaf count and bucket population are not anonymity sets.
 */

import * as fs from "fs";
import {
  SMALL_SNAPSHOT_LEAF_COUNT_THRESHOLD,
  LOW_BUCKET_POPULATION_THRESHOLD,
  collectWitnessSnapshotHygieneWarnings,
} from "../../lib/zk_hygiene/snapshot";

// ── Constants ─────────────────────────────────────────────────────────────────

const USAGE = `Usage: npx ts-node --project tsconfig.json scripts/ops/analyze_snapshot_hygiene.ts \\
  --snapshot <path> [--leaf-index <n>] [--denomination <lamports>] \\
  [--small-leaf-threshold <n>] [--low-bucket-threshold <n>] [--json]

No RPC. No secrets. No witnesses. No proof artifacts.
This report is not a privacy guarantee. No warning does not mean private.`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AnalyzeArgs {
  snapshotPath: string;
  leafIndex?: number;
  denomination?: bigint;
  smallLeafThreshold: number;
  lowBucketThreshold: number;
  json: boolean;
}

export interface HygieneReport {
  ok: boolean;
  mode: "snapshot_hygiene_report";
  snapshotPath: string;
  leafCount: number;
  smallLeafThreshold: number;
  lowBucketThreshold: number;
  selectedLeafIndex: number | null;
  selectedLeafIsLatest: boolean | null;
  selectedDenomination: string | null;
  bucketPopulation: Record<string, number>;
  selectedBucketPopulation: number | null;
  warnings: string[];
  notes: string[];
}

export interface AnalyzeDeps {
  readFileSync?: (path: string) => string;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

// ── Arg parser ────────────────────────────────────────────────────────────────

export function parseAnalyzeArgs(argv: string[]): AnalyzeArgs {
  const VALUED_FLAGS = new Set([
    "--snapshot",
    "--leaf-index",
    "--denomination",
    "--small-leaf-threshold",
    "--low-bucket-threshold",
  ]);
  const BOOL_FLAGS = new Set(["--json"]);

  let snapshotPath: string | undefined;
  let leafIndex: number | undefined;
  let denomination: bigint | undefined;
  let smallLeafThreshold = SMALL_SNAPSHOT_LEAF_COUNT_THRESHOLD;
  let lowBucketThreshold = LOW_BUCKET_POPULATION_THRESHOLD;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];

    if (VALUED_FLAGS.has(flag)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        throw new Error("parseAnalyzeArgs: " + flag + " requires a value");
      }
      const value = argv[++i];

      switch (flag) {
        case "--snapshot":
          snapshotPath = value;
          break;
        case "--leaf-index": {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 0) {
            throw new Error(
              "parseAnalyzeArgs: --leaf-index must be a non-negative integer, got: " +
                JSON.stringify(value)
            );
          }
          leafIndex = n;
          break;
        }
        case "--denomination": {
          let d: bigint;
          try {
            d = BigInt(value);
          } catch {
            throw new Error(
              "parseAnalyzeArgs: --denomination must be a positive integer, got: " +
                JSON.stringify(value)
            );
          }
          if (d <= 0n) {
            throw new Error(
              "parseAnalyzeArgs: --denomination must be a positive integer, got: " +
                JSON.stringify(value)
            );
          }
          denomination = d;
          break;
        }
        case "--small-leaf-threshold": {
          const n = Number(value);
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error(
              "parseAnalyzeArgs: --small-leaf-threshold must be a positive integer, got: " +
                JSON.stringify(value)
            );
          }
          smallLeafThreshold = n;
          break;
        }
        case "--low-bucket-threshold": {
          const n = Number(value);
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error(
              "parseAnalyzeArgs: --low-bucket-threshold must be a positive integer, got: " +
                JSON.stringify(value)
            );
          }
          lowBucketThreshold = n;
          break;
        }
      }
    } else if (BOOL_FLAGS.has(flag)) {
      if (flag === "--json") json = true;
    } else {
      throw new Error("parseAnalyzeArgs: unknown flag: " + flag);
    }
  }

  if (snapshotPath === undefined) {
    throw new Error("parseAnalyzeArgs: --snapshot is required");
  }

  return {
    snapshotPath,
    leafIndex,
    denomination,
    smallLeafThreshold,
    lowBucketThreshold,
    json,
  };
}

// ── Denomination normalizer ───────────────────────────────────────────────────

// Accepts positive integers in string, number, or bigint form.
// Strings are parsed via BigInt so "001000" normalizes to "1000".
// Returns canonical decimal string, or null for any invalid/zero/negative value.
function normalizeDenomination(raw: unknown): string | null {
  try {
    let n: bigint;
    if (typeof raw === "bigint") {
      n = raw;
    } else if (typeof raw === "number") {
      if (!Number.isFinite(raw) || raw !== Math.trunc(raw)) return null;
      n = BigInt(Math.trunc(raw));
    } else if (typeof raw === "string") {
      n = BigInt(raw);
    } else {
      return null;
    }
    if (n <= 0n) return null;
    return n.toString();
  } catch {
    return null;
  }
}

// ── Report builder ────────────────────────────────────────────────────────────

export function buildHygieneReport(
  args: AnalyzeArgs,
  rawSnapshot: string
): HygieneReport {
  let snap: unknown;
  try {
    snap = JSON.parse(rawSnapshot);
  } catch (e) {
    throw new Error("analyze_snapshot: invalid JSON: " + (e as Error).message);
  }

  if (typeof snap !== "object" || snap === null) {
    throw new Error("analyze_snapshot: snapshot is not an object");
  }

  const snapObj = snap as Record<string, unknown>;

  // Resolve events array — prefer "events", fall back to "leaves"
  let events: unknown[];
  if (Array.isArray(snapObj["events"])) {
    events = snapObj["events"] as unknown[];
  } else if (Array.isArray(snapObj["leaves"])) {
    events = snapObj["leaves"] as unknown[];
  } else {
    throw new Error(
      "analyze_snapshot: snapshot must have an events or leaves array"
    );
  }

  // Resolve leaf count — prefer explicit field, derive from array as fallback
  let leafCount: number;
  if (typeof snapObj["leaf_count"] === "number") {
    leafCount = snapObj["leaf_count"] as number;
  } else {
    leafCount = events.length;
  }

  // Validate leaf index range
  if (args.leafIndex !== undefined && args.leafIndex >= leafCount) {
    throw new Error(
      "analyze_snapshot: --leaf-index " +
        args.leafIndex +
        " is out of range (leaf_count=" +
        leafCount +
        ")"
    );
  }

  // Tally denomination buckets
  const bucketMap = new Map<string, number>();
  for (const evt of events) {
    const e = evt as Record<string, unknown>;
    const denStr = normalizeDenomination(e["denomination"]);
    if (denStr !== null) {
      bucketMap.set(denStr, (bucketMap.get(denStr) ?? 0) + 1);
    }
  }
  const bucketPopulation: Record<string, number> = {};
  for (const [k, v] of bucketMap) {
    bucketPopulation[k] = v;
  }

  // Determine selected denomination
  let selectedDenomination: string | null = null;
  if (args.denomination !== undefined) {
    selectedDenomination = args.denomination.toString();
  } else if (args.leafIndex !== undefined) {
    for (const evt of events) {
      const e = evt as Record<string, unknown>;
      const liRaw = e["leaf_index"];
      const li = liRaw !== undefined && liRaw !== null ? Number(liRaw) : NaN;
      if (!Number.isNaN(li) && li === args.leafIndex) {
        const denStr = normalizeDenomination(e["denomination"]);
        if (denStr !== null) {
          selectedDenomination = denStr;
        }
        break;
      }
    }
  }

  const selectedBucketPopulation =
    selectedDenomination !== null
      ? bucketMap.get(selectedDenomination) ?? 0
      : null;

  let selectedLeafIsLatest: boolean | null = null;
  if (args.leafIndex !== undefined && leafCount > 0) {
    selectedLeafIsLatest = args.leafIndex === leafCount - 1;
  }

  // Collect warnings
  const warnings: string[] = [];

  // SMALL_SNAPSHOT_LEAF_COUNT and (if leaf selected) SELECTED_LEAF_IS_LATEST.
  // Passing sentinel -1 when no leafIndex is given: it never equals leafCount-1
  // so SELECTED_LEAF_IS_LATEST is suppressed, while the leaf-count check runs.
  const hygieneLeafIndex = args.leafIndex ?? -1;
  warnings.push(
    ...collectWitnessSnapshotHygieneWarnings({
      leafIndex: hygieneLeafIndex,
      leafCount,
      smallLeafThreshold: args.smallLeafThreshold,
    })
  );

  // LOW_BUCKET_POPULATION
  if (
    selectedDenomination !== null &&
    selectedBucketPopulation !== null &&
    selectedBucketPopulation > 0 &&
    selectedBucketPopulation < args.lowBucketThreshold
  ) {
    warnings.push(
      "[LOW_BUCKET_POPULATION] Only " +
        selectedBucketPopulation +
        " leaves in denomination bucket " +
        selectedDenomination +
        ". Bucket population is not an anonymity set," +
        " but very small buckets are weak privacy hygiene for privacy-mode testing."
    );
  }

  const notes = [
    "This report is not a privacy guarantee. No warning does not mean private.",
    "Leaf count and bucket population are only coarse public-state diagnostics.",
  ];

  return {
    ok: true,
    mode: "snapshot_hygiene_report",
    snapshotPath: args.snapshotPath,
    leafCount,
    smallLeafThreshold: args.smallLeafThreshold,
    lowBucketThreshold: args.lowBucketThreshold,
    selectedLeafIndex: args.leafIndex ?? null,
    selectedLeafIsLatest,
    selectedDenomination,
    bucketPopulation,
    selectedBucketPopulation,
    warnings,
    notes,
  };
}

// ── Human formatter ───────────────────────────────────────────────────────────

function printHumanReport(
  report: HygieneReport,
  log: (msg: string) => void
): void {
  log("Snapshot hygiene report");
  log("snapshot_path:        " + report.snapshotPath);
  log("leaf_count:           " + report.leafCount);
  log("small_leaf_threshold: " + report.smallLeafThreshold);
  log("low_bucket_threshold: " + report.lowBucketThreshold);
  if (report.selectedLeafIndex !== null) {
    log("selected_leaf_index:     " + report.selectedLeafIndex);
    log(
      "selected_leaf_is_latest: " +
        (report.selectedLeafIsLatest !== null
          ? String(report.selectedLeafIsLatest)
          : "(unknown)")
    );
  }
  if (report.selectedDenomination !== null) {
    log("selected_denomination:      " + report.selectedDenomination);
    log(
      "selected_bucket_population: " + (report.selectedBucketPopulation ?? 0)
    );
  }
  log("bucket_population:");
  const keys = Object.keys(report.bucketPopulation);
  if (keys.length === 0) {
    log("  (empty)");
  } else {
    for (const k of keys) {
      log("  " + k + ": " + report.bucketPopulation[k]);
    }
  }
  if (report.warnings.length > 0) {
    log("warnings:");
    for (const w of report.warnings) {
      log("  " + w);
    }
  } else {
    log("warnings: (none)");
  }
  log("notes:");
  for (const n of report.notes) {
    log("  " + n);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runAnalyzeSnapshotHygiene(
  argv: string[],
  deps?: AnalyzeDeps
): number {
  const readFileSync =
    deps?.readFileSync ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  const log = deps?.log ?? console.log.bind(console);
  const warn = deps?.warn ?? console.warn.bind(console);

  let args: AnalyzeArgs;
  try {
    args = parseAnalyzeArgs(argv);
  } catch (e) {
    warn("Error: " + (e as Error).message);
    return 1;
  }

  let raw: string;
  try {
    raw = readFileSync(args.snapshotPath);
  } catch (e) {
    warn(
      'Error: cannot read snapshot file "' +
        args.snapshotPath +
        '": ' +
        (e as Error).message
    );
    return 1;
  }

  let report: HygieneReport;
  try {
    report = buildHygieneReport(args, raw);
  } catch (e) {
    warn("Error: " + (e as Error).message);
    return 1;
  }

  if (args.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report, log);
  }

  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const code = runAnalyzeSnapshotHygiene(argv);
  process.exit(code);
}
