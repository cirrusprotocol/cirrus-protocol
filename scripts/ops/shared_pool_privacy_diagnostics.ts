#!/usr/bin/env ts-node
/**
 * Shared-pool privacy diagnostics for devnet-alpha rehearsal artifacts.
 *
 * Deterministic, offline, read-only diagnostics — NOT an AI model. It analyzes
 * an existing v2 indexer snapshot and the selected withdrawal context and prints
 * conservative privacy-risk warnings before a user proceeds to witness export or
 * simulate.
 *
 * Offline / read-only contract:
 *   - opens no RPC connection
 *   - uses no wallet, signs nothing, sends no transaction
 *   - generates no proof or witness
 *   - reads no note secret, no keypair, no proof / public-inputs / witness file
 *   - reads no wasm / zkey / ptau artifact
 *   - submits no root, deposits nothing, withdraws nothing, requests no airdrop
 *   - writes nothing; the only file it reads is the snapshot JSON passed in
 *
 * Warnings never fail the command. The command exits non-zero only for a
 * malformed snapshot, an invalid leaf index, an invalid --root format, or a
 * --root that does not match the snapshot root.
 */

import * as fs from "fs";

// ── Types ────────────────────────────────────────────────────────────────────

export type Severity = "info" | "warning" | "high";

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
}

export interface DiagnosticsResult {
  ok: boolean;
  root: string;
  snapshotVersion: number;
  leafCount: number;
  eventCount?: number;
  selectedLeafIndex: number;
  warnings: Diagnostic[];
  failures: Diagnostic[];
}

export interface DiagArgs {
  snapshot: string;
  leafIndex: number;
  root?: string;
  denomination?: string;
  fee?: string;
  recipient?: string;
  relayer?: string;
  commitmentAgeSlots?: number;
  json: boolean;
}

export interface ParsedSnapshot {
  version: number;
  root: string; // last_root_be_hex, lowercased
  leafCount: number;
  eventCount?: number;
  meta?: Record<string, unknown>;
}

// ── Validation helpers ───────────────────────────────────────────────────────

const ROOT_HEX_RE = /^[0-9a-fA-F]{64}$/;
const INT_RE = /^[0-9]+$/;
const ALL_ZERO_ROOT = "0".repeat(64);

/**
 * Parses a non-negative integer within the JS safe-integer range, or throws a
 * clear error. Rejects values beyond 2^53-1 so a too-large index/age fails loudly
 * instead of silently rounding.
 */
export function parseSafeNonNegInt(raw: string, flag: string): number {
  if (!INT_RE.test(raw)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${flag} must be a non-negative integer within the safe integer range`
    );
  }
  return value;
}

/** Throws unless hex is exactly 64 hex chars and not the all-zero root. */
export function validateRootHex(hex: string, label = "root"): void {
  if (typeof hex !== "string" || !ROOT_HEX_RE.test(hex)) {
    throw new Error(`${label}: must be exactly 64 hex characters`);
  }
  if (hex.toLowerCase() === ALL_ZERO_ROOT) {
    throw new Error(`${label}: must not be the all-zero root`);
  }
}

/**
 * Structurally validates an already-parsed snapshot object and normalizes the
 * fields the diagnostics need. Tolerant about optional fields (events, meta)
 * but fails clearly when the essentials are missing or malformed.
 */
export function parseSnapshot(obj: unknown): ParsedSnapshot {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error("snapshot must be a JSON object");
  }
  const s = obj as Record<string, unknown>;

  if (s.version !== 2) {
    throw new Error(
      `snapshot version must be 2 (v2 indexer snapshot); got ${JSON.stringify(
        s.version
      )}`
    );
  }
  if (typeof s.last_root_be_hex !== "string") {
    throw new Error("snapshot last_root_be_hex must be a string");
  }
  validateRootHex(s.last_root_be_hex, "snapshot last_root_be_hex");
  if (
    typeof s.leaf_count !== "number" ||
    !Number.isInteger(s.leaf_count) ||
    s.leaf_count <= 0
  ) {
    throw new Error(
      `snapshot leaf_count must be a positive integer; got ${JSON.stringify(
        s.leaf_count
      )}`
    );
  }

  const eventCount = Array.isArray(s.events) ? s.events.length : undefined;
  const meta =
    typeof s.meta === "object" && s.meta !== null
      ? (s.meta as Record<string, unknown>)
      : undefined;

  return {
    version: s.version,
    root: s.last_root_be_hex.toLowerCase(),
    leafCount: s.leaf_count,
    eventCount,
    meta,
  };
}

/** Reads and validates a snapshot JSON file (the only file this tool reads). */
export function readSnapshotFile(filePath: string): ParsedSnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `cannot read snapshot at ${filePath}: ${(err as Error).message}`
    );
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${filePath}: ${(err as Error).message}`);
  }
  return parseSnapshot(obj);
}

// ── Argument parsing ─────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): DiagArgs {
  let snapshot: string | undefined;
  let leafIndexRaw: string | undefined;
  let root: string | undefined;
  let denomination: string | undefined;
  let fee: string | undefined;
  let recipient: string | undefined;
  let relayer: string | undefined;
  let commitmentAgeRaw: string | undefined;
  let json = false;

  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--snapshot":
        snapshot = need(i, flag);
        i++;
        break;
      case "--leaf-index":
        leafIndexRaw = need(i, flag);
        i++;
        break;
      case "--root":
        root = need(i, flag);
        i++;
        break;
      case "--denomination":
        denomination = need(i, flag);
        i++;
        break;
      case "--fee":
        fee = need(i, flag);
        i++;
        break;
      case "--recipient":
        recipient = need(i, flag);
        i++;
        break;
      case "--relayer":
        relayer = need(i, flag);
        i++;
        break;
      case "--commitment-age-slots":
        commitmentAgeRaw = need(i, flag);
        i++;
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }

  if (snapshot === undefined) {
    throw new Error("--snapshot is required");
  }
  if (leafIndexRaw === undefined) {
    throw new Error("--leaf-index is required");
  }
  const leafIndex = parseSafeNonNegInt(leafIndexRaw, "--leaf-index");

  if (root !== undefined) {
    validateRootHex(root, "--root");
  }
  if (denomination !== undefined && !INT_RE.test(denomination)) {
    throw new Error("--denomination must be a non-negative integer (lamports)");
  }
  if (fee !== undefined && !INT_RE.test(fee)) {
    throw new Error("--fee must be a non-negative integer (lamports)");
  }
  let commitmentAgeSlots: number | undefined;
  if (commitmentAgeRaw !== undefined) {
    commitmentAgeSlots = parseSafeNonNegInt(
      commitmentAgeRaw,
      "--commitment-age-slots"
    );
  }

  return {
    snapshot,
    leafIndex,
    root,
    denomination,
    fee,
    recipient,
    relayer,
    commitmentAgeSlots,
    json,
  };
}

// ── Analysis ─────────────────────────────────────────────────────────────────

const SMALL_SET_WARN = 32;
const SMALL_SET_HIGH = 8;

/**
 * Pure diagnostics. Produces conservative privacy warnings and any hard
 * failures (root mismatch, out-of-range leaf index). Warnings never set ok=false.
 */
export function analyze(
  snapshot: ParsedSnapshot,
  args: DiagArgs
): DiagnosticsResult {
  const warnings: Diagnostic[] = [];
  const failures: Diagnostic[] = [];
  const leafCount = snapshot.leafCount;
  const idx = args.leafIndex;

  // 1. SMALL_ANONYMITY_SET
  if (leafCount < SMALL_SET_HIGH) {
    warnings.push({
      code: "SMALL_ANONYMITY_SET",
      severity: "high",
      message: `Anonymity set is very small (leaf_count=${leafCount} < ${SMALL_SET_HIGH}); a withdrawal is easy to correlate with its deposit.`,
    });
  } else if (leafCount < SMALL_SET_WARN) {
    warnings.push({
      code: "SMALL_ANONYMITY_SET",
      severity: "warning",
      message: `Anonymity set is small (leaf_count=${leafCount} < ${SMALL_SET_WARN}); privacy is weak until the set grows.`,
    });
  }

  // 2/3. Leaf position (and out-of-range failure)
  if (idx >= leafCount) {
    failures.push({
      code: "LEAF_INDEX_OUT_OF_RANGE",
      severity: "high",
      message: `Selected leaf index ${idx} is out of range for leaf_count ${leafCount} (valid 0..${
        leafCount - 1
      }).`,
    });
  } else if (idx === leafCount - 1) {
    warnings.push({
      code: "SELECTED_LEAF_IS_LATEST",
      severity: "high",
      message: `Selected leaf is the most recent leaf (index ${idx} of ${leafCount}); the newest deposit is the easiest to link.`,
    });
  } else if (idx <= 1 || idx >= leafCount - 2) {
    warnings.push({
      code: "SELECTED_LEAF_NEAR_EDGE",
      severity: "warning",
      message: `Selected leaf ${idx} is near an edge of the set (within the first or last 2 of ${leafCount}); edge leaves are easier to correlate.`,
    });
  }

  // 4. ROOT_MISMATCH (hard failure)
  if (
    args.root !== undefined &&
    args.root.toLowerCase() !== snapshot.root.toLowerCase()
  ) {
    failures.push({
      code: "ROOT_MISMATCH",
      severity: "high",
      message: `Provided --root does not match the snapshot root (--root=${args.root.toLowerCase()} snapshot=${snapshot.root.toLowerCase()}).`,
    });
  }

  // 5-8. Visibility warnings (only when the relevant context is supplied)
  if (args.denomination !== undefined) {
    warnings.push({
      code: "AMOUNT_VISIBILITY",
      severity: "warning",
      message: `Withdrawal amount is public on-chain (denomination=${args.denomination} lamports); the amount bucket alone can narrow the candidate set.`,
    });
  }
  if (args.fee !== undefined) {
    warnings.push({
      code: "FEE_VISIBILITY",
      severity: "warning",
      message: `Fee is public on-chain (fee=${args.fee} lamports); an unusual fee can narrow which flow a withdrawal belongs to.`,
    });
  }
  if (args.recipient !== undefined) {
    warnings.push({
      code: "RECIPIENT_VISIBILITY",
      severity: "warning",
      message: `Recipient is public in the current devnet-alpha withdrawal flow; reusing a recipient links withdrawals together.`,
    });
  }
  if (args.relayer !== undefined) {
    warnings.push({
      code: "RELAYER_VISIBILITY",
      severity: "warning",
      message: `Relayer is public; repeated use of the same relayer can correlate otherwise-unrelated withdrawals.`,
    });
  }

  // 9. TIMING_RISK (always)
  const ageNote =
    args.commitmentAgeSlots !== undefined
      ? ` Deposit is ~${args.commitmentAgeSlots} slots old; a short deposit-to-withdraw gap correlates strongly.`
      : "";
  warnings.push({
    code: "TIMING_RISK",
    severity: "warning",
    message: `Deposit and withdrawal timing can correlate users, especially with a small set.${ageNote}`,
  });

  // 10. OPERATOR_ROOT_RISK (always)
  warnings.push({
    code: "OPERATOR_ROOT_RISK",
    severity: "info",
    message: `Root submission is operator-managed in this alpha; you rely on the operator to allow-list the root you withdraw against.`,
  });

  // 11. SIMULATE_ONLY_NOT_PRIVACY (always)
  warnings.push({
    code: "SIMULATE_ONLY_NOT_PRIVACY",
    severity: "info",
    message: `A successful simulation proves execution readiness, not privacy; it does not improve your anonymity set.`,
  });

  return {
    ok: failures.length === 0,
    root: snapshot.root.toLowerCase(),
    snapshotVersion: snapshot.version,
    leafCount,
    eventCount: snapshot.eventCount,
    selectedLeafIndex: idx,
    warnings,
    failures,
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatJson(result: DiagnosticsResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatText(result: DiagnosticsResult): string {
  const lines: string[] = [];
  lines.push(
    "Shared pool privacy diagnostics — devnet alpha (offline, read-only)"
  );
  lines.push("");
  lines.push(`  root:                ${result.root}`);
  lines.push(`  snapshot_version:    ${result.snapshotVersion}`);
  lines.push(`  leaf_count:          ${result.leafCount}`);
  if (result.eventCount !== undefined) {
    lines.push(`  event_count:         ${result.eventCount}`);
  }
  lines.push(`  selected_leaf_index: ${result.selectedLeafIndex}`);
  lines.push(`  ok:                  ${result.ok}`);
  lines.push("");

  if (result.failures.length > 0) {
    lines.push("Failures:");
    for (const f of result.failures) {
      lines.push(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
    }
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of result.warnings) {
      lines.push(`  [${w.severity.toUpperCase()}] ${w.code}: ${w.message}`);
    }
  } else {
    lines.push("No warnings.");
  }

  lines.push("");
  lines.push(
    "Devnet alpha. Unaudited. Not for real funds. No privacy guarantee. Not"
  );
  lines.push(
    "Tornado-level privacy. Simulation proves execution readiness, not privacy."
  );
  return lines.join("\n");
}

// ── Help text ────────────────────────────────────────────────────────────────

export function helpText(): string {
  return [
    "shared_pool_privacy_diagnostics.ts — offline, read-only privacy diagnostics",
    "for a devnet-alpha shared-pool withdrawal context.",
    "",
    "This is deterministic diagnostics, not an AI model. It analyzes an existing",
    "v2 indexer snapshot and the selected withdrawal context and prints",
    "conservative privacy-risk warnings before you proceed to witness export or",
    "simulate.",
    "",
    "Offline and read-only: it opens no RPC connection, uses no wallet, signs",
    "nothing, sends no transaction, and generates no proof or witness. It never",
    "reads a note secret, a keypair, a proof, a public-inputs file, or a witness",
    "file, and it writes nothing. The only file it reads is the snapshot JSON.",
    "",
    "Usage:",
    "  npx ts-node --project tsconfig.json \\",
    "    scripts/ops/shared_pool_privacy_diagnostics.ts \\",
    "    --snapshot <snapshot-path> --leaf-index <n> [options]",
    "",
    "Required flags:",
    "  --snapshot <path>          v2 indexer snapshot JSON to analyze (read-only).",
    "  --leaf-index <n>           Index of the deposit leaf you intend to withdraw.",
    "",
    "Optional flags:",
    "  --root <64-hex-root>       Expected snapshot root; a mismatch fails non-zero.",
    "  --denomination <lamports>  Withdrawal amount (amount-visibility warning).",
    "  --fee <lamports>           Relayer fee (fee-visibility warning).",
    "  --recipient <pubkey>       Recipient (recipient-visibility warning).",
    "  --relayer <pubkey>         Relayer (relayer-visibility warning).",
    "  --commitment-age-slots <n> Approx. deposit age in slots (timing context).",
    "  --json                     Emit a stable JSON object instead of text.",
    "  --help, -h                 Print this help and exit.",
    "",
    "Exit codes:",
    "  0   diagnostics completed with no hard failure (warnings do not fail).",
    "  1   malformed snapshot, invalid leaf index, invalid --root, or root mismatch.",
    "",
    "Examples:",
    "  # Text diagnostics for the selected leaf:",
    "  npx ts-node --project tsconfig.json \\",
    "    scripts/ops/shared_pool_privacy_diagnostics.ts \\",
    "    --snapshot <snapshot-path> --leaf-index <n>",
    "",
    "  # JSON, with a root guard and visibility context:",
    "  npx ts-node --project tsconfig.json \\",
    "    scripts/ops/shared_pool_privacy_diagnostics.ts \\",
    "    --snapshot <snapshot-path> --leaf-index <n> --root <64-hex-root> \\",
    "    --denomination <lamports> --fee <lamports> --recipient <recipient> \\",
    "    --relayer <relayer> --json",
  ].join("\n");
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    process.exit(0);
  }

  const args = ((): DiagArgs => {
    try {
      return parseArgs(argv);
    } catch (err) {
      console.error((err as Error).message);
      return process.exit(1);
    }
  })();

  const snapshot = ((): ParsedSnapshot => {
    try {
      return readSnapshotFile(args.snapshot);
    } catch (err) {
      console.error((err as Error).message);
      return process.exit(1);
    }
  })();

  const result = analyze(snapshot, args);
  console.log(args.json ? formatJson(result) : formatText(result));
  process.exit(result.ok ? 0 : 1);
}
