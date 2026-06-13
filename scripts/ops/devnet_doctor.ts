#!/usr/bin/env ts-node
/**
 * scripts/ops/devnet_doctor.ts
 *
 * Read-only devnet health check for the Cirrus devnet alpha program.
 * Requires no wallet, no private key, and makes no on-chain mutations.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *     npx ts-node scripts/ops/devnet_doctor.ts [options]
 *
 * Flags:
 *   --help              Print this usage and exit 0
 *   --allow-non-devnet  Downgrade non-devnet RPC URL from FAIL to WARN
 *   --strict            Treat WARNs as failures (exit 1 on any WARN)
 *   --json              Output a JSON report instead of human-readable text
 *   --no-color          Disable ANSI colors in human output
 *
 * Exit codes:
 *   0  No FAILs (and no WARNs when --strict is set)
 *   1  One or more FAILs, ANCHOR_PROVIDER_URL unset, or WARNs with --strict
 */

import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

// ── Constants ─────────────────────────────────────────────────────────────────

// Source: docs/DEVNET_ALPHA_RUNBOOK.md:5, scripts/deploy_devnet.sh:47
const PROGRAM_ID = new PublicKey(
  "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq"
);

// Source: README.md:39, docs/DEVNET_ALPHA_RUNBOOK.md:139
const EXPECTED_UPGRADE_AUTH = "GdiRFMEZs9Tpt3sbTEgg5o1x1aPVC4fy236S64mNrpax";

// Source: docs/SECURITY_MODEL.md:128, docs/KNOWN_LIMITATIONS.md:21
const EXPECTED_CHAIN_ID_STR = "1";

// Anchor account discriminators. These constants are required for manual
// read-only deserialization. Keep in sync with the on-chain account names
// PoolState and VerifierConfig.
const DISC_POOL = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
const DISC_CFG = Buffer.from([176, 103, 248, 36, 138, 167, 176, 220]);

// System program (all-zeros address)
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

// Operator/smoke-test threshold — not a production solvency requirement
const MIN_RECOMMENDED_POOL_BALANCE_LAMPORTS = 10_000_000; // 0.01 SOL

// Account size constants — must match programs/shielded_pool_anchor/src/migration.rs
const LEGACY_POOL_LEN = 17;
const CURRENT_POOL_LEN = 57;
const LEGACY_CONFIG_LEN = 311;
const PREV_CONFIG_LEN = 667;
const CURRENT_CONFIG_LEN = 699;

const MIGRATE_HINT =
  "run scripts/ops/migrate_devnet.ts after deploying migration-capable binary";

// Must match MAX_ROOTS in programs/shielded_pool_anchor/src/state.rs.
export const MAX_ROOTS = 10;

// Warn when this many or more roots are in use.
const NEAR_CAPACITY_THRESHOLD = MAX_ROOTS - 2; // 8

// NoteTreeState discriminator: sha256("account:NoteTreeState")[0..8]
const DISC_NOTE_TREE = Buffer.from([37, 238, 107, 83, 189, 18, 107, 116]);
// NoteTreeState::LEN = discriminator(8) + leaf_count(8) + tree_depth(1) + bump(1) + padding(6)
const NOTE_TREE_STATE_LEN = 24;
const EXPECTED_NOTE_TREE_DEPTH = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

type Status = "PASS" | "WARN" | "FAIL" | "INFO";

type CheckEntry = {
  status: Status;
  label: string;
  detail: string;
  hint: string;
};

type PoolLayout = "legacy" | "current" | "invalid";
type ConfigLayout = "legacy" | "previous" | "current" | "invalid";

type ParsedPool =
  | {
      layout: "current";
      authority: PublicKey;
      totalDeposits: bigint;
      totalWithdrawals: bigint;
      bump: number;
    }
  | {
      layout: "legacy";
      totalWithdrawnLamports: bigint;
      bump: number;
    };

type ParsedConfig =
  | {
      layout: "current";
      adminAuthority: PublicKey;
      attesterPubkey: PublicKey;
      rootSubmitterAuthority: PublicKey;
      chainId: bigint;
      paused: boolean;
      threshold: number;
      verifierPubkeys: PublicKey[];
      allowedRootsCount: number;
      bump: number;
    }
  | {
      layout: "previous";
      adminAuthority: PublicKey;
      attesterPubkey: PublicKey;
      chainId: bigint;
      paused: boolean;
      threshold: number;
      verifierPubkeys: PublicKey[];
      allowedRootsCount: number;
      bump: number;
    }
  | {
      layout: "legacy";
      adminAuthority: PublicKey;
      chainId: bigint;
      paused: boolean;
      threshold: number;
      verifierPubkeys: PublicKey[];
      bump: number;
    };

type Observed = {
  poolBalanceLamports: number | null;
  totalWithdrawalsLamports: string | null;
  totalDepositsLamports: string | null;
  poolLayout: PoolLayout | null;
  chainId: string | null;
  paused: boolean | null;
  threshold: number | null;
  verifierCount: number | null;
  adminAuthority: string | null;
  rootSubmitterAuthority: string | null;
  attesterPubkey: string | null;
  verifierPubkeys: string[];
  configLayout: ConfigLayout | null;
  allowedRootsCount: number | null;
  capacityRemaining: number | null;
  adminEqualsRootSubmitter: boolean | null;
  attesterInVerifierSet: boolean | null;
  noteTreePda: string | null;
  noteTreeLeafCount: number | null;
};

// ── Allowed-roots analysis ────────────────────────────────────────────────────

export interface AllowedRootsAnalysis {
  allowedRootsCount: number;
  maxRoots: number;
  nearCapacityThreshold: number;
  capacityRemaining: number;
  isFull: boolean;
  isNearCapacity: boolean;
  adminEqualsRootSubmitter: boolean;
  attesterInVerifierSet: boolean | null;
}

export function analyzeAllowedRootsState(input: {
  allowedRootsCount: number;
  maxRoots: number;
  nearCapacityThreshold: number;
  adminAuthorityStr: string;
  rootSubmitterAuthorityStr: string | null;
  attesterPubkeyStr: string | null;
  verifierPubkeyStrs: string[];
}): AllowedRootsAnalysis {
  const {
    allowedRootsCount,
    maxRoots,
    nearCapacityThreshold,
    adminAuthorityStr,
    rootSubmitterAuthorityStr,
    attesterPubkeyStr,
    verifierPubkeyStrs,
  } = input;
  const capacityRemaining = maxRoots - allowedRootsCount;
  const isFull = allowedRootsCount >= maxRoots;
  const isNearCapacity = !isFull && allowedRootsCount >= nearCapacityThreshold;
  const adminEqualsRootSubmitter =
    rootSubmitterAuthorityStr !== null &&
    adminAuthorityStr === rootSubmitterAuthorityStr;
  const attesterInVerifierSet =
    attesterPubkeyStr !== null
      ? verifierPubkeyStrs.some((p) => p === attesterPubkeyStr)
      : null;
  return {
    allowedRootsCount,
    maxRoots,
    nearCapacityThreshold,
    capacityRemaining,
    isFull,
    isNearCapacity,
    adminEqualsRootSubmitter,
    attesterInVerifierSet,
  };
}

// ── NoteTreeState analysis ────────────────────────────────────────────────────

export interface NoteTreeStateAnalysis {
  exists: boolean;
  ownerMatchesProgram: boolean | null;
  decoded: boolean;
  leafCount: number | null;
  treeDepth: number | null;
  isEmpty: boolean | null;
  warnings: string[];
}

export function analyzeNoteTreeState(input: {
  programIdStr: string;
  accountInfo: {
    owner: PublicKey;
    data: Buffer | Uint8Array;
  } | null;
}): NoteTreeStateAnalysis {
  const { programIdStr, accountInfo } = input;

  if (accountInfo === null) {
    return {
      exists: false,
      ownerMatchesProgram: null,
      decoded: false,
      leafCount: null,
      treeDepth: null,
      isEmpty: null,
      warnings: [
        "[NOTE_TREE_MISSING] Note tree state PDA not found." +
          " Run init_note_tree_devnet.ts --yes before deposit/witness/snapshot flows.",
      ],
    };
  }

  const warnings: string[] = [];
  const ownerStr = accountInfo.owner.toBase58();
  const ownerMatchesProgram = ownerStr === programIdStr;

  if (!ownerMatchesProgram) {
    warnings.push(
      "[NOTE_TREE_OWNER_MISMATCH] Note tree account owner " +
        ownerStr +
        " does not match program ID " +
        programIdStr +
        "."
    );
  }

  const data = Buffer.isBuffer(accountInfo.data)
    ? accountInfo.data
    : Buffer.from(accountInfo.data);

  if (data.length !== NOTE_TREE_STATE_LEN) {
    warnings.push(
      "[NOTE_TREE_UNEXPECTED_DATA_LENGTH] Note tree data length is " +
        data.length +
        ", expected " +
        NOTE_TREE_STATE_LEN +
        "."
    );
    return {
      exists: true,
      ownerMatchesProgram,
      decoded: false,
      leafCount: null,
      treeDepth: null,
      isEmpty: null,
      warnings,
    };
  }

  if (!DISC_NOTE_TREE.every((b, i) => data[i] === b)) {
    warnings.push(
      "[NOTE_TREE_DISCRIMINATOR_MISMATCH] Note tree account discriminator does" +
        " not match NoteTreeState. Account may belong to a different program."
    );
    return {
      exists: true,
      ownerMatchesProgram,
      decoded: false,
      leafCount: null,
      treeDepth: null,
      isEmpty: null,
      warnings,
    };
  }

  const leafCount = Number((data as Buffer).readBigUInt64LE(8));
  const treeDepth = data[16];
  const isEmpty = leafCount === 0;

  if (treeDepth !== EXPECTED_NOTE_TREE_DEPTH) {
    warnings.push(
      "[NOTE_TREE_UNEXPECTED_DEPTH] Note tree depth is " +
        treeDepth +
        ", expected " +
        EXPECTED_NOTE_TREE_DEPTH +
        ". Verify the program and indexer use the same TREE_DEPTH constant."
    );
  }

  if (isEmpty) {
    warnings.push(
      "[NOTE_TREE_EMPTY] Note tree has zero leaves. Run deposit_note before" +
        " witness/snapshot flows."
    );
  }

  return {
    exists: true,
    ownerMatchesProgram,
    decoded: true,
    leafCount,
    treeDepth,
    isEmpty,
    warnings,
  };
}

// ── Collector state ───────────────────────────────────────────────────────────

let failCount = 0;
let warnCount = 0;
let minPoolBalanceLamports = MIN_RECOMMENDED_POOL_BALANCE_LAMPORTS;

// display includes null sentinels for blank-line section breaks (human output only)
const display: Array<CheckEntry | null> = [];
// checks is the flat list for JSON output
const checks: CheckEntry[] = [];

const observed: Observed = {
  poolBalanceLamports: null,
  totalWithdrawalsLamports: null,
  totalDepositsLamports: null,
  poolLayout: null,
  chainId: null,
  paused: null,
  threshold: null,
  verifierCount: null,
  adminAuthority: null,
  rootSubmitterAuthority: null,
  attesterPubkey: null,
  verifierPubkeys: [],
  configLayout: null,
  allowedRootsCount: null,
  capacityRemaining: null,
  adminEqualsRootSubmitter: null,
  attesterInVerifierSet: null,
  noteTreePda: null,
  noteTreeLeafCount: null,
};

function sep(): void {
  display.push(null);
}

function collect(status: Status, label: string, detail = "", hint = ""): void {
  if (status === "FAIL") failCount++;
  if (status === "WARN") warnCount++;
  const entry: CheckEntry = { status, label, detail, hint };
  display.push(entry);
  checks.push(entry);
}

function pass(label: string, detail = ""): void {
  collect("PASS", label, detail);
}
function warn(label: string, detail = "", hint = ""): void {
  collect("WARN", label, detail, hint);
}
function fail(label: string, detail = "", hint = ""): void {
  collect("FAIL", label, detail, hint);
}
function info(label: string, detail = ""): void {
  collect("INFO", label, detail);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderHuman(
  noColor: boolean,
  strict: boolean,
  rpcUrl: string,
  poolPdaStr: string,
  cfgPdaStr: string
): void {
  const c = (code: string): string => (noColor ? "" : code);
  const reset = c("\x1b[0m");
  const bold = c("\x1b[1m");
  const dim = c("\x1b[2m");
  const green = c("\x1b[1;32m");
  const yellow = c("\x1b[1;33m");
  const red = c("\x1b[1;31m");
  const statusCol: Record<Status, string> = {
    PASS: green,
    WARN: yellow,
    FAIL: red,
    INFO: dim,
  };

  console.log(
    `\n── Devnet Doctor ────────────────────────────────────────────\n`
  );

  for (const entry of display) {
    if (entry === null) {
      console.log();
      continue;
    }
    const col = statusCol[entry.status];
    const tag = `[${entry.status}]`.padEnd(6);
    console.log(`${col}${tag}${reset} ${entry.label}`);
    if (entry.detail) console.log(`       ${col}${entry.detail}${reset}`);
    if (entry.hint) console.log(`       ${dim}→ ${entry.hint}${reset}`);
  }

  // Observed state section
  const hasObserved =
    poolPdaStr !== "" ||
    cfgPdaStr !== "" ||
    observed.adminAuthority !== null ||
    observed.chainId !== null ||
    observed.paused !== null ||
    observed.threshold !== null ||
    observed.verifierCount !== null ||
    observed.poolBalanceLamports !== null ||
    observed.poolLayout !== null ||
    observed.configLayout !== null ||
    observed.noteTreePda !== null;

  if (hasObserved) {
    console.log();
    console.log(
      `${bold}── Observed State ───────────────────────────────────────────${reset}`
    );
    const row = (k: string, v: string): void =>
      console.log(`  ${dim}${k.padEnd(20)}${reset}${v}`);
    row("Program ID", PROGRAM_ID.toBase58());
    if (poolPdaStr) row("Pool PDA", poolPdaStr);
    if (cfgPdaStr) row("Config PDA", cfgPdaStr);
    if (observed.poolLayout !== null) row("Pool layout", observed.poolLayout);
    if (observed.configLayout !== null)
      row("Config layout", observed.configLayout);
    if (observed.adminAuthority !== null)
      row("Admin authority", observed.adminAuthority);
    if (observed.rootSubmitterAuthority !== null)
      row("Root submitter", observed.rootSubmitterAuthority);
    if (observed.attesterPubkey !== null)
      row("Attester pubkey", observed.attesterPubkey);
    if (observed.chainId !== null) row("Chain ID", observed.chainId);
    if (observed.paused !== null) row("Paused", String(observed.paused));
    if (observed.threshold !== null)
      row("Threshold", String(observed.threshold));
    if (observed.verifierCount !== null)
      row("Verifier count", String(observed.verifierCount));
    if (observed.allowedRootsCount !== null) {
      const cap =
        observed.capacityRemaining !== null
          ? `  (${observed.capacityRemaining} remaining)`
          : "";
      row(
        "Allowed roots",
        `${observed.allowedRootsCount} / ${MAX_ROOTS}${cap}`
      );
    }
    if (observed.adminEqualsRootSubmitter !== null)
      row("Admin=RootSubmitter", String(observed.adminEqualsRootSubmitter));
    if (observed.attesterInVerifierSet !== null)
      row("Attester in set", String(observed.attesterInVerifierSet));
    if (observed.totalDepositsLamports !== null) {
      const sol = (
        Number(observed.totalDepositsLamports) / LAMPORTS_PER_SOL
      ).toFixed(9);
      row(
        "Total deposits",
        `${observed.totalDepositsLamports} lamports  (${sol} SOL)`
      );
    }
    if (observed.totalWithdrawalsLamports !== null) {
      const sol = (
        Number(observed.totalWithdrawalsLamports) / LAMPORTS_PER_SOL
      ).toFixed(9);
      row(
        "Total withdrawals",
        `${observed.totalWithdrawalsLamports} lamports  (${sol} SOL)`
      );
    }
    if (observed.poolBalanceLamports !== null) {
      const sol = (observed.poolBalanceLamports / LAMPORTS_PER_SOL).toFixed(9);
      row(
        "Pool balance",
        `${observed.poolBalanceLamports} lamports  (${sol} SOL)`
      );
    }
    if (observed.noteTreePda !== null)
      row("Note tree PDA", observed.noteTreePda);
    if (observed.noteTreeLeafCount !== null)
      row("Note tree leaves", String(observed.noteTreeLeafCount));
  }

  // Summary
  console.log();
  console.log("─".repeat(64));
  if (failCount === 0 && warnCount === 0) {
    console.log(`${green}  Devnet Doctor PASSED — no issues found.${reset}`);
  } else if (failCount === 0 && !strict) {
    console.log(
      `${yellow}  Devnet Doctor PASSED with ${warnCount} warning(s).${reset}`
    );
    console.log(`${dim}  (FAILs only cause non-zero exit)${reset}`);
  } else if (failCount === 0 && strict) {
    console.log(
      `${red}  Devnet Doctor FAILED (strict) — 0 failure(s), ${warnCount} warning(s).${reset}`
    );
    console.log(`${dim}  (strict: FAILs or WARNs cause non-zero exit)${reset}`);
  } else {
    const policy = strict
      ? "strict: FAILs or WARNs cause non-zero exit"
      : "FAILs only cause non-zero exit";
    console.log(
      `${red}  Devnet Doctor FAILED — ${failCount} failure(s), ${warnCount} warning(s).${reset}`
    );
    console.log(`${dim}  (${policy})${reset}`);
  }
  console.log("─".repeat(64));
  console.log();
}

function renderJson(
  rpcUrl: string,
  poolPdaStr: string,
  cfgPdaStr: string
): void {
  console.log(
    JSON.stringify(
      {
        rpcUrl,
        programId: PROGRAM_ID.toBase58(),
        poolPda: poolPdaStr,
        configPda: cfgPdaStr,
        minRecommendedPoolBalanceLamports: minPoolBalanceLamports,
        failCount,
        warnCount,
        checks,
        observed,
      },
      null,
      2
    )
  );
}

function render(
  jsonMode: boolean,
  noColor: boolean,
  strict: boolean,
  rpcUrl: string,
  poolPdaStr: string,
  cfgPdaStr: string
): void {
  if (jsonMode) renderJson(rpcUrl, poolPdaStr, cfgPdaStr);
  else renderHuman(noColor, strict, rpcUrl, poolPdaStr, cfgPdaStr);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// Format a lamport deficit as a SOL decimal string with 9 places, trimming
// trailing zeros but keeping at least one digit after the decimal point.
// e.g. 8990800 → "0.0089908",  1000000000 → "1.0",  1 → "0.000000001"
function formatSolAmount(lamports: number): string {
  const raw = (lamports / LAMPORTS_PER_SOL).toFixed(9);
  const trimmed = raw.replace(/\.?0+$/, "");
  return trimmed.includes(".") ? trimmed : trimmed + ".0";
}

// ── Borsh helpers ─────────────────────────────────────────────────────────────

function readU64LE(buf: Buffer, offset: number): bigint {
  return (buf as any).readBigUInt64LE(offset);
}

function discMatches(data: Buffer, disc: Buffer): boolean {
  if (data.length < 8) return false;
  return disc.every((b, i) => data[i] === b);
}

// Parse PoolState from raw account bytes.
// Returns a discriminated union based on detected layout, or null if the
// discriminator does not match or the account size is unrecognized.
//
// Layouts:
//   Current (57 bytes): disc[8] authority[32] total_deposits[8]
//                       total_withdrawals[8] bump[1]
//   Legacy  (17 bytes): disc[8] total_withdrawn_lamports[8] bump[1]
function parsePoolState(data: Buffer): ParsedPool | null {
  if (!discMatches(data, DISC_POOL)) return null;

  if (data.length === CURRENT_POOL_LEN) {
    const authority = new PublicKey(data.slice(8, 40));
    const totalDeposits = readU64LE(data, 40);
    const totalWithdrawals = readU64LE(data, 48);
    const bump = data[56];
    return {
      layout: "current",
      authority,
      totalDeposits,
      totalWithdrawals,
      bump,
    };
  }

  if (data.length === LEGACY_POOL_LEN) {
    const totalWithdrawnLamports = readU64LE(data, 8);
    const bump = data[16];
    return { layout: "legacy", totalWithdrawnLamports, bump };
  }

  return null; // unrecognized size
}

// Parse VerifierConfig from raw account bytes.
// Returns a discriminated union based on detected layout, or null if the
// discriminator does not match, the account size is unrecognized, or the
// variable-length fields overflow the account buffer.
//
// Layouts:
//   Current  (699 bytes): disc[8] admin[32] attester[32] root_submitter[32]
//                         chain_id[8] paused[1] threshold[1]
//                         verifiers_len[4] verifiers[n*32]
//                         roots_len[4] roots[m*32] bump[1]
//   Previous (667 bytes): disc[8] admin[32] attester[32] chain_id[8]
//                         paused[1] threshold[1] verifiers_len[4] verifiers[n*32]
//                         roots_len[4] roots[m*32] bump[1]
//   Legacy   (311 bytes): disc[8] admin[32] chain_id[8] paused[1]
//                         threshold[1] verifiers_len[4] verifiers[n*32] bump[1]
function parseVerifierConfig(data: Buffer): ParsedConfig | null {
  if (!discMatches(data, DISC_CFG)) return null;

  if (data.length === CURRENT_CONFIG_LEN) {
    // Need at least up to verifiers_len prefix (offset 118)
    if (data.length < 118) return null;

    const adminAuthority = new PublicKey(data.slice(8, 40));
    const attesterPubkey = new PublicKey(data.slice(40, 72));
    const rootSubmitterAuthority = new PublicKey(data.slice(72, 104));
    const chainId = readU64LE(data, 104);
    const paused = data[112] !== 0;
    const threshold = data[113];
    const verifiersLen = data.readUInt32LE(114);

    // Bounds: verifier data + roots_len prefix
    const verifiersEnd = 118 + verifiersLen * 32;
    if (data.length < verifiersEnd + 4) return null;

    const verifierPubkeys: PublicKey[] = [];
    for (let i = 0; i < verifiersLen; i++) {
      verifierPubkeys.push(
        new PublicKey(data.slice(118 + i * 32, 118 + (i + 1) * 32))
      );
    }

    const rootsLen = data.readUInt32LE(verifiersEnd);
    const rootsEnd = verifiersEnd + 4 + rootsLen * 32;
    if (data.length < rootsEnd + 1) return null;

    const bump = data[rootsEnd];
    return {
      layout: "current",
      adminAuthority,
      attesterPubkey,
      rootSubmitterAuthority,
      chainId,
      paused,
      threshold,
      verifierPubkeys,
      allowedRootsCount: rootsLen,
      bump,
    };
  }

  if (data.length === PREV_CONFIG_LEN) {
    // Previous layout (667 bytes): no root_submitter_authority field.
    if (data.length < 86) return null;

    const adminAuthority = new PublicKey(data.slice(8, 40));
    const attesterPubkey = new PublicKey(data.slice(40, 72));
    const chainId = readU64LE(data, 72);
    const paused = data[80] !== 0;
    const threshold = data[81];
    const verifiersLen = data.readUInt32LE(82);

    const verifiersEnd = 86 + verifiersLen * 32;
    if (data.length < verifiersEnd + 4) return null;

    const verifierPubkeys: PublicKey[] = [];
    for (let i = 0; i < verifiersLen; i++) {
      verifierPubkeys.push(
        new PublicKey(data.slice(86 + i * 32, 86 + (i + 1) * 32))
      );
    }

    const rootsLen = data.readUInt32LE(verifiersEnd);
    const rootsEnd = verifiersEnd + 4 + rootsLen * 32;
    if (data.length < rootsEnd + 1) return null;

    const bump = data[rootsEnd];
    return {
      layout: "previous",
      adminAuthority,
      attesterPubkey,
      chainId,
      paused,
      threshold,
      verifierPubkeys,
      allowedRootsCount: rootsLen,
      bump,
    };
  }

  if (data.length === LEGACY_CONFIG_LEN) {
    if (data.length < 54) return null;

    const adminAuthority = new PublicKey(data.slice(8, 40));
    const chainId = readU64LE(data, 40);
    const paused = data[48] !== 0;
    const threshold = data[49];
    const vecLen = data.readUInt32LE(50);

    const needed = 54 + vecLen * 32 + 1;
    if (data.length < needed) return null;

    const verifierPubkeys: PublicKey[] = [];
    for (let i = 0; i < vecLen; i++) {
      verifierPubkeys.push(
        new PublicKey(data.slice(54 + i * 32, 54 + (i + 1) * 32))
      );
    }
    const bump = data[54 + vecLen * 32];
    return {
      layout: "legacy",
      adminAuthority,
      chainId,
      paused,
      threshold,
      verifierPubkeys,
      bump,
    };
  }

  return null; // unrecognized size
}

// ── PDAs ──────────────────────────────────────────────────────────────────────

async function derivePoolPda(): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress([Buffer.from("pool_state")], PROGRAM_ID);
}

async function deriveConfigPda(): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress(
    [Buffer.from("verifier_config")],
    PROGRAM_ID
  );
}

async function deriveNoteTreePda(): Promise<[PublicKey, number]> {
  return PublicKey.findProgramAddress([Buffer.from("note_tree")], PROGRAM_ID);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const USAGE = `
Usage:
  ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \\
    npx ts-node scripts/ops/devnet_doctor.ts [options]

Flags:
  --help                   Print this usage and exit 0
  --allow-non-devnet       Downgrade non-devnet RPC URL from FAIL to WARN
  --strict                 Treat WARNs as failures (exit 1 on any WARN)
  --skip-upgrade-authority-warning
                           Suppress upgrade-authority WARNs (parse failure or frozen
                           program). PASS/FAIL results (match/mismatch) are always shown.
                           Use with --strict after verifying the authority externally.
  --json                   Output a JSON report (no ANSI colors)
  --no-color               Disable ANSI colors in human output
  --min-pool-lamports <n>         Override pool balance threshold (non-negative integer lamports)
  --min-pool-sol <n>              Override pool balance threshold (non-negative decimal SOL)
                                  Default threshold: ${MIN_RECOMMENDED_POOL_BALANCE_LAMPORTS} lamports (0.01 SOL)
  --suggest-funding-command       Print a copy-paste solana CLI transfer command when pool is low
  --funding-source <path>         Append --keypair <path> to the suggested funding command

Exit codes:
  0  No FAILs (and no WARNs when --strict is set)
  1  One or more FAILs, ANCHOR_PROVIDER_URL unset, or WARNs with --strict
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }

  // ── Argument validation ──────────────────────────────────────────────────────
  {
    const BOOL_FLAGS = new Set([
      "--help",
      "--allow-non-devnet",
      "--strict",
      "--json",
      "--no-color",
      "--suggest-funding-command",
      "--skip-upgrade-authority-warning",
    ]);
    const VALUE_FLAGS = new Set([
      "--min-pool-lamports",
      "--min-pool-sol",
      "--funding-source",
    ]);
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (VALUE_FLAGS.has(arg)) {
        i += 2; // skip flag + its value token; value-specific errors fire later
      } else if (BOOL_FLAGS.has(arg)) {
        i += 1;
      } else if (arg.startsWith("--")) {
        console.error(`FAIL: unknown flag: ${arg}`);
        console.error("");
        console.error(USAGE);
        process.exit(1);
      } else {
        console.error(`FAIL: unexpected argument: ${arg}`);
        console.error("");
        console.error(USAGE);
        process.exit(1);
      }
    }
  }

  const allowNonDevnet = args.includes("--allow-non-devnet");
  const strict = args.includes("--strict");
  const skipUpgradeAuthWarn = args.includes("--skip-upgrade-authority-warning");
  const jsonMode = args.includes("--json");
  const noColor = args.includes("--no-color") || jsonMode;

  // ── Pool balance threshold flags (mutually exclusive) ────────────────────────
  const lamportsIdx = args.indexOf("--min-pool-lamports");
  const solIdx = args.indexOf("--min-pool-sol");

  if (lamportsIdx !== -1 && solIdx !== -1) {
    console.error(
      "FAIL: Use only one of --min-pool-lamports or --min-pool-sol"
    );
    process.exit(1);
  }

  if (lamportsIdx !== -1) {
    const raw = args[lamportsIdx + 1];
    if (!raw || raw.startsWith("--")) {
      console.error(
        "FAIL: --min-pool-lamports requires a non-negative integer value"
      );
      process.exit(1);
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      console.error(
        `FAIL: --min-pool-lamports must be a non-negative integer, got: ${raw}`
      );
      process.exit(1);
    }
    minPoolBalanceLamports = n;
  }

  if (solIdx !== -1) {
    const raw = args[solIdx + 1];
    if (!raw || raw.startsWith("--")) {
      console.error(
        "FAIL: --min-pool-sol requires a non-negative decimal value"
      );
      process.exit(1);
    }
    const n = Number(raw);
    if (isNaN(n) || n < 0) {
      console.error(
        `FAIL: --min-pool-sol must be a non-negative number, got: ${raw}`
      );
      process.exit(1);
    }
    minPoolBalanceLamports = Math.floor(n * LAMPORTS_PER_SOL);
  }

  const suggestFunding = args.includes("--suggest-funding-command");
  const fundingSourceIdx = args.indexOf("--funding-source");
  let fundingSource = "";
  if (fundingSourceIdx !== -1) {
    const raw = args[fundingSourceIdx + 1];
    if (!raw || raw.startsWith("--")) {
      console.error("FAIL: --funding-source requires a path value");
      process.exit(1);
    }
    fundingSource = raw;
  }

  let poolPdaStr = "";
  let cfgPdaStr = "";
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL ?? "";

  // ── Env checks ──────────────────────────────────────────────────────────────

  if (!rpcUrl) {
    fail(
      "ANCHOR_PROVIDER_URL is not set",
      "Set it to https://api.devnet.solana.com before running",
      "set ANCHOR_PROVIDER_URL=https://api.devnet.solana.com before running"
    );
    render(jsonMode, noColor, strict, rpcUrl, poolPdaStr, cfgPdaStr);
    process.exit(1);
  }

  if (rpcUrl.includes("mainnet")) {
    fail(
      "RPC endpoint contains 'mainnet' — refusing to run against mainnet",
      rpcUrl
    );
    render(jsonMode, noColor, strict, rpcUrl, poolPdaStr, cfgPdaStr);
    process.exit(1);
  }

  if (rpcUrl.includes("devnet")) {
    pass("RPC endpoint is devnet", rpcUrl);
  } else if (allowNonDevnet) {
    warn(
      "RPC endpoint does not contain 'devnet'",
      `${rpcUrl}  (--allow-non-devnet passed)`
    );
  } else {
    fail(
      "RPC endpoint does not look like devnet",
      `${rpcUrl}  — pass --allow-non-devnet to suppress`,
      "set ANCHOR_PROVIDER_URL=https://api.devnet.solana.com or pass --allow-non-devnet intentionally"
    );
  }

  if (process.env.ANCHOR_WALLET) {
    info(
      "ANCHOR_WALLET is set but ignored",
      "This tool is read-only and requires no wallet or private key"
    );
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  const conn = new Connection(rpcUrl, "confirmed");

  // ── Program deployment ──────────────────────────────────────────────────────

  sep();
  const programInfo = await conn.getAccountInfo(PROGRAM_ID);
  if (!programInfo) {
    fail(
      "Program account not found on chain",
      PROGRAM_ID.toBase58(),
      "deploy program with scripts/deploy_devnet.sh"
    );
  } else {
    pass("Program account exists", PROGRAM_ID.toBase58());
    if (programInfo.executable) {
      pass("Program account is executable");
    } else {
      fail("Program account is NOT executable");
    }
  }

  // Upgrade authority — use jsonParsed RPC encoding to avoid manual COption<Pubkey> byte layout.
  // Reads BPF Upgradeable Loader ProgramData account via two parsed account fetches.
  if (programInfo) {
    let onChainUpgradeAuth: string | null | undefined = undefined;
    try {
      const parsedProg = await conn.getParsedAccountInfo(PROGRAM_ID);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const progAccData = parsedProg.value?.data as any;
      if (
        progAccData &&
        progAccData.program === "bpfUpgradeableLoader" &&
        progAccData.parsed?.type === "program" &&
        progAccData.parsed?.info?.programData
      ) {
        const pdAddr = new PublicKey(progAccData.parsed.info.programData);
        const parsedPd = await conn.getParsedAccountInfo(pdAddr);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdAccData = parsedPd.value?.data as any;
        if (
          pdAccData &&
          pdAccData.program === "bpfUpgradeableLoader" &&
          pdAccData.parsed?.type === "programData"
        ) {
          const auth = pdAccData.parsed.info?.authority;
          onChainUpgradeAuth = typeof auth === "string" ? auth : null;
        }
      }
    } catch (_) {
      // RPC node does not support jsonParsed or returned unexpected format
    }

    if (onChainUpgradeAuth === undefined) {
      if (skipUpgradeAuthWarn) {
        info(
          "Upgrade authority check skipped",
          "--skip-upgrade-authority-warning passed"
        );
      } else {
        warn(
          "Upgrade authority — RPC did not return parsed BPF loader data",
          `verify: solana program show ${PROGRAM_ID.toBase58()} --url devnet`
        );
      }
    } else if (onChainUpgradeAuth === null) {
      if (skipUpgradeAuthWarn) {
        info("Upgrade authority", "null — program is frozen (non-upgradeable)");
      } else {
        warn(
          "Upgrade authority is null — program is non-upgradeable",
          "frozen with --final or authority removed",
          "confirm intentional; frozen programs cannot be patched"
        );
      }
    } else if (onChainUpgradeAuth === EXPECTED_UPGRADE_AUTH) {
      pass("Upgrade authority matches expected value", onChainUpgradeAuth);
    } else {
      fail(
        "Upgrade authority MISMATCH",
        `on-chain=${onChainUpgradeAuth}`,
        `expected ${EXPECTED_UPGRADE_AUTH} — investigate before any deploy or admin action`
      );
    }
    info(
      "  Expected upgrade authority",
      `${EXPECTED_UPGRADE_AUTH}  (source: README.md:39, SECURITY_MODEL.md §10)`
    );
  }

  // ── Pool PDA ─────────────────────────────────────────────────────────────────

  sep();
  const [poolPda, poolBump] = await derivePoolPda();
  poolPdaStr = poolPda.toBase58();
  info("Pool PDA (derived)", `${poolPdaStr}  bump=${poolBump}`);

  const poolInfo = await conn.getAccountInfo(poolPda);
  if (!poolInfo) {
    fail(
      "Pool PDA account not found",
      poolPdaStr,
      "run scripts/ops/init_devnet.ts first"
    );
  } else {
    pass("Pool PDA account exists", poolPdaStr);

    const pool = parsePoolState(poolInfo.data as Buffer);

    if (!pool) {
      observed.poolLayout = "invalid";
      fail(
        "Pool PDA discriminator mismatch or unrecognized account size",
        `size=${poolInfo.data.length}  expected ${LEGACY_POOL_LEN} (legacy) or ${CURRENT_POOL_LEN} (current)`,
        "account may belong to a different program or be uninitialized"
      );
    } else if (pool.layout === "legacy") {
      observed.poolLayout = "legacy";
      fail(
        `Pool PDA uses legacy ${LEGACY_POOL_LEN}-byte layout`,
        "Pool cannot process withdrawals until the account layout is migrated",
        MIGRATE_HINT
      );
      if (pool.bump === poolBump) {
        pass("Pool PDA bump matches derived bump", String(pool.bump));
      } else {
        warn(
          "Pool PDA bump mismatch",
          `on-chain=${pool.bump}  derived=${poolBump}`
        );
      }
      observed.totalWithdrawalsLamports =
        pool.totalWithdrawnLamports.toString();
      const solWithdrawn =
        Number(pool.totalWithdrawnLamports) / LAMPORTS_PER_SOL;
      info(
        "  total_withdrawn_lamports (legacy field)",
        `${pool.totalWithdrawnLamports.toString()} lamports  (${solWithdrawn.toFixed(
          9
        )} SOL)`
      );
    } else {
      // Current layout
      observed.poolLayout = "current";
      pass("Pool PDA discriminator matches PoolState (current layout)");
      if (pool.bump === poolBump) {
        pass("Pool PDA bump matches derived bump", String(pool.bump));
      } else {
        warn(
          "Pool PDA bump mismatch",
          `on-chain=${pool.bump}  derived=${poolBump}`
        );
      }
      info("  authority", pool.authority.toBase58());
      observed.totalDepositsLamports = pool.totalDeposits.toString();
      info(
        "  total_deposits",
        `${pool.totalDeposits.toString()} lamports  (${(
          Number(pool.totalDeposits) / LAMPORTS_PER_SOL
        ).toFixed(9)} SOL)`
      );
      observed.totalWithdrawalsLamports = pool.totalWithdrawals.toString();
      info(
        "  total_withdrawals",
        `${pool.totalWithdrawals.toString()} lamports  (${(
          Number(pool.totalWithdrawals) / LAMPORTS_PER_SOL
        ).toFixed(9)} SOL)`
      );
    }

    // Pool balance check runs regardless of layout
    const poolBalance = await conn.getBalance(poolPda);
    observed.poolBalanceLamports = poolBalance;
    info(
      "  Pool vault balance",
      `${poolBalance} lamports  (${(poolBalance / LAMPORTS_PER_SOL).toFixed(
        9
      )} SOL)`
    );
    if (poolBalance < minPoolBalanceLamports) {
      let fundingHint: string;
      if (suggestFunding) {
        const deficit = minPoolBalanceLamports - poolBalance;
        const solAmount = formatSolAmount(deficit);
        const keypairFlag = fundingSource ? ` --keypair ${fundingSource}` : "";
        fundingHint =
          `fund the pool PDA with raw SOL transfer before smoke tests:\n` +
          `  solana transfer ${poolPdaStr} ${solAmount} --url devnet --allow-unfunded-recipient${keypairFlag}`;
      } else {
        fundingHint =
          "fund the pool PDA with a raw SystemProgram.transfer before smoke tests";
      }
      warn(
        "Pool balance is low",
        `${poolBalance} lamports below threshold ${minPoolBalanceLamports} lamports`,
        fundingHint
      );
    } else {
      pass(
        "Pool balance above minimum recommended threshold",
        `${poolBalance} lamports (threshold: ${minPoolBalanceLamports} lamports)`
      );
    }
  }

  // ── Config PDA ───────────────────────────────────────────────────────────────

  sep();
  const [cfgPda, cfgBump] = await deriveConfigPda();
  cfgPdaStr = cfgPda.toBase58();
  info("Config PDA (derived)", `${cfgPdaStr}  bump=${cfgBump}`);

  const cfgInfo = await conn.getAccountInfo(cfgPda);
  if (!cfgInfo) {
    fail(
      "Config PDA account not found",
      cfgPdaStr,
      "run scripts/ops/init_devnet.ts first"
    );
  } else {
    pass("Config PDA account exists", cfgPdaStr);

    const cfg = parseVerifierConfig(cfgInfo.data as Buffer);

    if (!cfg) {
      observed.configLayout = "invalid";
      fail(
        "Config PDA discriminator mismatch or unrecognized account size",
        `size=${cfgInfo.data.length}  expected ${LEGACY_CONFIG_LEN} (legacy), ${PREV_CONFIG_LEN} (previous), or ${CURRENT_CONFIG_LEN} (current)`,
        "account may belong to a different program or be uninitialized"
      );
    } else {
      // ── Layout detection ────────────────────────────────────────────────────
      if (cfg.layout === "legacy") {
        observed.configLayout = "legacy";
        fail(
          `Config PDA uses legacy ${LEGACY_CONFIG_LEN}-byte layout`,
          "Config cannot serve migrations or use attester/allowed-roots features until migrated",
          MIGRATE_HINT
        );
      } else if (cfg.layout === "previous") {
        observed.configLayout = "previous";
        fail(
          `Config PDA uses previous ${PREV_CONFIG_LEN}-byte layout (missing root_submitter_authority)`,
          "Deploy the updated binary and run migrate_devnet.ts to upgrade to the 699-byte layout",
          MIGRATE_HINT
        );
        observed.attesterPubkey = cfg.attesterPubkey.toBase58();
        info("  attester_pubkey", cfg.attesterPubkey.toBase58());
        observed.allowedRootsCount = cfg.allowedRootsCount;
        info("  allowed_roots count", String(cfg.allowedRootsCount));
      } else {
        observed.configLayout = "current";
        pass(
          "Config PDA discriminator matches VerifierConfig (current layout)"
        );
        observed.attesterPubkey = cfg.attesterPubkey.toBase58();
        info("  attester_pubkey", cfg.attesterPubkey.toBase58());
        observed.rootSubmitterAuthority = cfg.rootSubmitterAuthority.toBase58();
        info(
          "  root_submitter_authority",
          cfg.rootSubmitterAuthority.toBase58()
        );
        observed.allowedRootsCount = cfg.allowedRootsCount;
        info("  allowed_roots count", String(cfg.allowedRootsCount));
      }

      // ── Bump ────────────────────────────────────────────────────────────────
      if (cfg.bump === cfgBump) {
        pass("Config PDA bump matches derived bump", String(cfg.bump));
      } else {
        warn(
          "Config PDA bump mismatch",
          `on-chain=${cfg.bump}  derived=${cfgBump}`
        );
      }

      // ── chain_id ────────────────────────────────────────────────────────────
      const chainIdStr = String(cfg.chainId);
      observed.chainId = chainIdStr;
      if (chainIdStr === EXPECTED_CHAIN_ID_STR) {
        pass(
          `chain_id = ${chainIdStr}`,
          `(source: docs/SECURITY_MODEL.md:128)`
        );
      } else {
        fail(
          `chain_id mismatch`,
          `on-chain=${chainIdStr}  expected=${EXPECTED_CHAIN_ID_STR}`
        );
      }

      // ── paused flag ─────────────────────────────────────────────────────────
      observed.paused = cfg.paused;
      if (cfg.paused) {
        warn(
          "Program is PAUSED (cfg.paused = true)",
          "withdrawals will fail while paused; raw pool funding transfers are not gated by this flag",
          "run the operator admin flow (--unpause) with the admin wallet"
        );
      } else {
        pass("Program is not paused");
      }

      // ── threshold ───────────────────────────────────────────────────────────
      observed.threshold = cfg.threshold;
      info("  threshold", String(cfg.threshold));

      // ── admin_authority ─────────────────────────────────────────────────────
      observed.adminAuthority = cfg.adminAuthority.toBase58();
      info(
        "  admin_authority (display only — no expected value in tracked repo files)",
        cfg.adminAuthority.toBase58()
      );

      if (cfg.adminAuthority.equals(SYSTEM_PROGRAM)) {
        fail(
          "admin_authority is the system program (all-zeros)",
          "Config may be uninitialized or misconfigured"
        );
      }

      // ── verifier pubkeys ─────────────────────────────────────────────────────
      const verifierCount = cfg.verifierPubkeys.length;
      observed.verifierCount = verifierCount;
      observed.verifierPubkeys = cfg.verifierPubkeys.map((p) => p.toBase58());

      info(
        `  verifier_pubkeys (${verifierCount})`,
        verifierCount === 0
          ? "NONE — no verifiers registered"
          : cfg.verifierPubkeys
              .map((p) => p.toBase58())
              .join("\n                   ")
      );

      if (verifierCount === 0) {
        fail(
          "No verifier pubkeys registered in VerifierConfig",
          "No attestations possible — register at least one verifier",
          "rotate to persistent verifier keys"
        );
      }

      // ── threshold validation ─────────────────────────────────────────────────
      if (cfg.threshold > 0 && cfg.threshold <= verifierCount) {
        pass("Config threshold valid", `${cfg.threshold}-of-${verifierCount}`);
      } else {
        fail(
          "Config threshold invalid",
          `threshold=${cfg.threshold}  verifier_count=${verifierCount}`,
          "update verifier config with threshold in range 1..verifier_count"
        );
      }

      // ── single-operator / weak-threshold advisory ────────────────────────────
      // These are WARNs, not FAILs: threshold=1 is acceptable for local test and
      // single-operator alpha deployments. The warnings exist so operators running
      // the doctor in production-like contexts cannot miss the configuration risk.
      if (cfg.threshold === 1 && verifierCount === 1) {
        warn(
          "1-of-1 verifier config — single key controls all withdrawals",
          "compromise of this verifier key enables arbitrary pool drainage",
          "acceptable for single-operator alpha; consider 2-of-3 if keys are independently held"
        );
      } else if (cfg.threshold === 1) {
        warn(
          `threshold=1 with ${verifierCount} verifiers — any single key authorizes withdrawals`,
          `1-of-${verifierCount}: one verifier key compromise is sufficient to drain the pool`,
          "consider a higher threshold if verifier keys are held by independent parties"
        );
      }

      // ── duplicate verifier pubkeys ───────────────────────────────────────────
      const verifierStrs = cfg.verifierPubkeys.map((p) => p.toBase58());
      const uniqueVerifiers = new Set(verifierStrs);
      if (uniqueVerifiers.size === verifierCount) {
        pass("No duplicate verifier pubkeys");
      } else {
        fail(
          "Duplicate verifier pubkeys detected",
          `${verifierCount - uniqueVerifiers.size} duplicate(s) found`,
          "rotate verifier config to a unique verifier set"
        );
      }

      // ── zero/default verifier keys ───────────────────────────────────────────
      const hasZeroVerifier = cfg.verifierPubkeys.some((p) =>
        p.equals(SYSTEM_PROGRAM)
      );
      if (hasZeroVerifier) {
        fail(
          "Zero/default verifier pubkey detected",
          "One or more verifier pubkeys equal the system program address",
          "remove all-zeros/system-program pubkey from verifier set"
        );
      } else {
        pass("No zero/default verifier pubkeys");
      }

      // ── allowed-roots capacity (current layout only) ──────────────────────
      if (cfg.layout === "current") {
        sep();
        const rootsAnalysis = analyzeAllowedRootsState({
          allowedRootsCount: cfg.allowedRootsCount,
          maxRoots: MAX_ROOTS,
          nearCapacityThreshold: NEAR_CAPACITY_THRESHOLD,
          adminAuthorityStr: cfg.adminAuthority.toBase58(),
          rootSubmitterAuthorityStr: cfg.rootSubmitterAuthority.toBase58(),
          attesterPubkeyStr: cfg.attesterPubkey.toBase58(),
          verifierPubkeyStrs: cfg.verifierPubkeys.map((p) => p.toBase58()),
        });
        observed.capacityRemaining = rootsAnalysis.capacityRemaining;
        observed.adminEqualsRootSubmitter =
          rootsAnalysis.adminEqualsRootSubmitter;
        observed.attesterInVerifierSet = rootsAnalysis.attesterInVerifierSet;

        if (rootsAnalysis.isFull) {
          warn(
            "allowed_roots is full",
            `${rootsAnalysis.allowedRootsCount}/${rootsAnalysis.maxRoots}`,
            "remove a stale root via removeAllowedRoot before any new root submission"
          );
        } else if (rootsAnalysis.isNearCapacity) {
          warn(
            "allowed_roots near capacity",
            `${rootsAnalysis.allowedRootsCount}/${rootsAnalysis.maxRoots}  threshold=${rootsAnalysis.nearCapacityThreshold}`,
            "plan root lifecycle maintenance before more root submissions"
          );
        } else {
          pass(
            "allowed_roots capacity OK",
            `${rootsAnalysis.allowedRootsCount}/${rootsAnalysis.maxRoots}  (${rootsAnalysis.capacityRemaining} remaining)`
          );
        }

        if (rootsAnalysis.adminEqualsRootSubmitter) {
          warn(
            "admin_authority equals root_submitter_authority",
            "authority roles concentrated on one key",
            "acceptable for single-operator alpha; weaker role separation than separate keys"
          );
        } else {
          pass("admin_authority ≠ root_submitter_authority");
        }

        if (rootsAnalysis.attesterInVerifierSet === false) {
          warn(
            "attester_pubkey is not in the current verifier set",
            "may be stale config metadata after verifier rotation",
            "review config history before relying on attester labels"
          );
        } else if (rootsAnalysis.attesterInVerifierSet === true) {
          pass("attester_pubkey is in the verifier set");
        }
      }
    }
  }

  // ── NoteTree PDA ─────────────────────────────────────────────────────────────

  sep();
  const [noteTreePda, noteTreeBump] = await deriveNoteTreePda();
  const noteTreePdaStr = noteTreePda.toBase58();
  observed.noteTreePda = noteTreePdaStr;
  info("Note tree PDA (derived)", `${noteTreePdaStr}  bump=${noteTreeBump}`);

  const noteTreeInfo = await conn.getAccountInfo(noteTreePda);
  const ntAnalysis = analyzeNoteTreeState({
    programIdStr: PROGRAM_ID.toBase58(),
    accountInfo:
      noteTreeInfo !== null
        ? {
            owner: noteTreeInfo.owner,
            data: noteTreeInfo.data as Buffer,
          }
        : null,
  });

  if (!ntAnalysis.exists) {
    warn(
      "Note tree state PDA not found",
      noteTreePdaStr,
      "run scripts/ops/init_note_tree_devnet.ts --yes to initialize"
    );
  } else {
    pass("Note tree state PDA exists", noteTreePdaStr);

    if (!ntAnalysis.ownerMatchesProgram) {
      fail(
        "Note tree account owner does not match program ID",
        `owner=${noteTreeInfo!.owner.toBase58()}`,
        "account may belong to a different program or be misconfigured"
      );
    } else {
      pass("Note tree account owner matches program ID");
    }

    if (!ntAnalysis.decoded) {
      fail(
        "Note tree account data could not be decoded",
        `data length=${
          noteTreeInfo!.data.length
        }  expected=${NOTE_TREE_STATE_LEN}`,
        "account may be using a different layout; check discriminator"
      );
    } else {
      pass(
        "Note tree account decodes successfully",
        `tree_depth=${ntAnalysis.treeDepth}`
      );

      if (ntAnalysis.treeDepth !== EXPECTED_NOTE_TREE_DEPTH) {
        warn(
          "Note tree depth does not match expected depth",
          `on-chain=${ntAnalysis.treeDepth}  expected=${EXPECTED_NOTE_TREE_DEPTH}`,
          "verify the program and indexer use the same TREE_DEPTH constant"
        );
      }

      observed.noteTreeLeafCount = ntAnalysis.leafCount;
      info("  leaf_count (next leaf index)", String(ntAnalysis.leafCount));

      if (ntAnalysis.isEmpty) {
        warn(
          "Note tree is empty (leaf_count = 0)",
          "no notes deposited yet",
          "run scripts/ops/deposit_note_devnet.ts before witness/snapshot flows"
        );
      } else {
        pass("Note tree is non-empty", `leaf_count=${ntAnalysis.leafCount}`);
      }
    }
  }

  // ── Render and exit ──────────────────────────────────────────────────────────

  render(jsonMode, noColor, strict, rpcUrl, poolPdaStr, cfgPdaStr);

  const shouldFail = strict ? failCount > 0 || warnCount > 0 : failCount > 0;
  process.exit(shouldFail ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(
      "\x1b[1;31m[FATAL]\x1b[0m",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  });
}
