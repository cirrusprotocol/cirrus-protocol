#!/usr/bin/env ts-node
/**
 * scripts/ops/analyze_allowed_roots_hygiene.ts
 *
 * Read-only allowed-roots / config hygiene report CLI.
 *
 * Reads the on-chain verifier_config PDA through read-only RPC and emits
 * conservative operational diagnostics about root lifecycle and authority
 * concentration.
 *
 * Does not sign. Does not load keypairs. Does not send transactions.
 * Does not call sendRawTransaction. Does not submit roots.
 * Does not mutate any account.
 *
 * This report is not a privacy guarantee. It is a read-only operator diagnostic.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json scripts/ops/analyze_allowed_roots_hygiene.ts \
 *     --rpc-url https://api.devnet.solana.com \
 *     --program-id <PROGRAM_ID> \
 *     [--expected-root <64hex>] [--near-capacity-threshold <n>] \
 *     [--commitment processed|confirmed|finalized] [--json]
 *
 * Exit codes:
 *   0  Report generated successfully (warnings may be present)
 *   1  Invalid args, missing/unreadable config, malformed data, RPC read failure
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  MAX_ROOTS,
  decodeVerifierConfig,
  allowedRootsToHex,
  deriveConfigPda,
  validateRootHex,
} from "./inspect_allowed_roots_devnet";

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_NEAR_CAPACITY_THRESHOLD = MAX_ROOTS - 2; // 8

// ── Types ──────────────────────────────────────────────────────────────────────

export interface HygieneArgs {
  rpcUrl: string;
  programId: string;
  expectedRoot?: string;
  nearCapacityThreshold: number;
  commitment: "processed" | "confirmed" | "finalized";
  json: boolean;
}

export interface DecodedAllowedRootsConfig {
  programId: string;
  configPda: string;
  exists: boolean;
  paused: boolean;
  adminAuthority: string;
  rootSubmitterAuthority: string;
  attesterPubkey: string;
  verifierPubkeys: string[];
  threshold: number;
  verifierCount: number;
  allowedRoots: string[];
  maxRoots: number;
}

export interface AllowedRootsHygieneReport {
  ok: boolean;
  mode: "allowed_roots_hygiene_report";
  rpcUrl: string;
  programId: string;
  configPda: string;
  commitment: string;
  exists: boolean;
  paused: boolean;
  adminAuthority: string;
  rootSubmitterAuthority: string;
  adminEqualsRootSubmitter: boolean;
  attesterPubkey: string;
  attesterInVerifierSet: boolean;
  threshold: number;
  verifierCount: number;
  allowedRootCount: number;
  maxRoots: number;
  nearCapacityThreshold: number;
  capacityRemaining: number;
  allowedRoots: string[];
  expectedRoot: string | null;
  expectedRootPresent: boolean | null;
  warnings: string[];
  notes: string[];
}

export interface HygieneDeps {
  getAccountInfo: (
    pda: PublicKey,
    commitment: "processed" | "confirmed" | "finalized"
  ) => Promise<{ data: Buffer; owner?: PublicKey } | null>;
}

export interface AllowedRootsHygieneDeps {
  getAccountInfo?: (
    pda: PublicKey,
    commitment: "processed" | "confirmed" | "finalized"
  ) => Promise<{ data: Buffer; owner?: PublicKey } | null>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

// ── Arg parsing ────────────────────────────────────────────────────────────────

const VALUED_FLAGS = new Set([
  "--rpc-url",
  "--program-id",
  "--expected-root",
  "--near-capacity-threshold",
  "--commitment",
]);

const BOOL_FLAGS = new Set(["--json"]);

export function parseHygieneArgs(argv: string[]): HygieneArgs {
  let rpcUrl: string | undefined;
  let programId: string | undefined;
  let expectedRoot: string | undefined;
  let nearCapacityThreshold = DEFAULT_NEAR_CAPACITY_THRESHOLD;
  let commitment: "processed" | "confirmed" | "finalized" = "confirmed";
  let json = false;

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (VALUED_FLAGS.has(flag)) {
      const next = argv[i + 1];
      if (
        next === undefined ||
        BOOL_FLAGS.has(next) ||
        VALUED_FLAGS.has(next)
      ) {
        throw new Error(
          "parseHygieneArgs: " +
            flag +
            " requires a value but none was provided"
        );
      }
      switch (flag) {
        case "--rpc-url":
          rpcUrl = next;
          break;
        case "--program-id":
          try {
            new PublicKey(next);
          } catch {
            throw new Error(
              "parseHygieneArgs: --program-id is not a valid public key: " +
                next
            );
          }
          programId = next;
          break;
        case "--expected-root":
          validateRootHex(next, "--expected-root");
          expectedRoot = next.toLowerCase();
          break;
        case "--near-capacity-threshold": {
          const n = Number(next);
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error(
              "parseHygieneArgs: --near-capacity-threshold must be a" +
                " positive integer, got: " +
                JSON.stringify(next)
            );
          }
          nearCapacityThreshold = n;
          break;
        }
        case "--commitment":
          if (
            next !== "processed" &&
            next !== "confirmed" &&
            next !== "finalized"
          ) {
            throw new Error(
              "parseHygieneArgs: --commitment must be processed," +
                " confirmed, or finalized; got: " +
                next
            );
          }
          commitment = next;
          break;
      }
      i += 2;
    } else if (BOOL_FLAGS.has(flag)) {
      if (flag === "--json") json = true;
      i++;
    } else {
      throw new Error("parseHygieneArgs: unknown flag: " + flag);
    }
  }

  if (rpcUrl === undefined) {
    throw new Error("parseHygieneArgs: --rpc-url is required");
  }
  if (programId === undefined) {
    throw new Error("parseHygieneArgs: --program-id is required");
  }

  return {
    rpcUrl,
    programId,
    expectedRoot,
    nearCapacityThreshold,
    commitment,
    json,
  };
}

// ── Report builder ─────────────────────────────────────────────────────────────

export function buildAllowedRootsHygieneReport(
  args: HygieneArgs,
  decoded: DecodedAllowedRootsConfig
): AllowedRootsHygieneReport {
  const warnings: string[] = [];

  if (decoded.paused) {
    warnings.push(
      "[CONFIG_PAUSED] The protocol config is paused." +
        " This is operational state, not a privacy verdict."
    );
  }

  const count = decoded.allowedRoots.length;
  const max = decoded.maxRoots;
  const nearThreshold = args.nearCapacityThreshold;

  if (count >= max) {
    warnings.push(
      "[ALLOWED_ROOTS_FULL] allowed_roots appears full (" +
        count +
        "/" +
        max +
        "). New roots may fail until root lifecycle/reset/rotation is handled."
    );
  } else if (count >= nearThreshold) {
    warnings.push(
      "[ALLOWED_ROOTS_NEAR_CAPACITY] allowed_roots is close to full (" +
        count +
        "/" +
        max +
        ", near_threshold=" +
        nearThreshold +
        "). Root lifecycle maintenance may be needed before more root submissions."
    );
  }

  if (decoded.adminAuthority === decoded.rootSubmitterAuthority) {
    warnings.push(
      "[ADMIN_EQUALS_ROOT_SUBMITTER] admin_authority equals root_submitter_authority." +
        " Authority roles are concentrated." +
        " Acceptable for controlled devnet-alpha, but weaker operational separation."
    );
  }

  if (decoded.verifierCount === 0) {
    warnings.push(
      "[NO_VERIFIERS_CONFIGURED] No verifiers appear configured." +
        " This is operationally suspicious."
    );
  }

  if (decoded.threshold <= 1) {
    warnings.push(
      "[LOW_VERIFIER_THRESHOLD] threshold is " +
        decoded.threshold +
        ". Acceptable for devnet-alpha but weaker operational trust assumptions."
    );
  }

  const attesterInVerifierSet = decoded.verifierPubkeys.some(
    (p) => p === decoded.attesterPubkey
  );
  if (!attesterInVerifierSet) {
    warnings.push(
      "[ATTESTER_NOT_IN_VERIFIER_SET] attester_pubkey is not present" +
        " in the current verifier set." +
        " This may indicate stale config metadata after verifier rotation;" +
        " treat it as a devnet-alpha operator warning, not a privacy verdict."
    );
  }

  let expectedRootPresent: boolean | null = null;
  if (args.expectedRoot !== undefined) {
    const needle = args.expectedRoot.toLowerCase();
    expectedRootPresent = decoded.allowedRoots.some(
      (r) => r.toLowerCase() === needle
    );
    if (!expectedRootPresent) {
      warnings.push(
        "[EXPECTED_ROOT_MISSING] The expected root " +
          args.expectedRoot +
          " is not currently in the allowed_roots list." +
          " A live withdraw_zk using that root should not proceed."
      );
    } // closes if (!expectedRootPresent)
  } // closes if (args.expectedRoot !== undefined)

  const capacityRemaining = max - count;

  return {
    ok: true,
    mode: "allowed_roots_hygiene_report",
    rpcUrl: args.rpcUrl,
    programId: decoded.programId,
    configPda: decoded.configPda,
    commitment: args.commitment,
    exists: decoded.exists,
    paused: decoded.paused,
    adminAuthority: decoded.adminAuthority,
    rootSubmitterAuthority: decoded.rootSubmitterAuthority,
    adminEqualsRootSubmitter:
      decoded.adminAuthority === decoded.rootSubmitterAuthority,
    attesterPubkey: decoded.attesterPubkey,
    attesterInVerifierSet,
    threshold: decoded.threshold,
    verifierCount: decoded.verifierCount,
    allowedRootCount: count,
    maxRoots: max,
    nearCapacityThreshold: nearThreshold,
    capacityRemaining,
    allowedRoots: decoded.allowedRoots,
    expectedRoot: args.expectedRoot !== undefined ? args.expectedRoot : null,
    expectedRootPresent,
    warnings,
    notes: [
      "This report is not a privacy guarantee.",
      "Allowed-roots state is an operational trust and root-lifecycle diagnostic.",
    ],
  };
}

// ── Human formatter ────────────────────────────────────────────────────────────

export function formatHumanHygieneReport(
  report: AllowedRootsHygieneReport,
  log: (msg: string) => void
): void {
  log("Allowed roots hygiene report");
  log("program_id:               " + report.programId);
  log("config_pda:               " + report.configPda);
  log("commitment:               " + report.commitment);
  log("paused:                   " + report.paused);
  log(
    "allowed_roots:            " +
      report.allowedRootCount +
      " / " +
      report.maxRoots
  );
  log("capacity_remaining:       " + report.capacityRemaining);
  log("admin_authority:          " + report.adminAuthority);
  log("root_submitter_authority: " + report.rootSubmitterAuthority);
  log("admin_equals_root_submitter: " + report.adminEqualsRootSubmitter);
  log("attester_pubkey:          " + report.attesterPubkey);
  log("attester_in_verifier_set: " + report.attesterInVerifierSet);
  if (report.expectedRoot !== null) {
    log("expected_root:            " + report.expectedRoot);
    log("expected_root_present:    " + report.expectedRootPresent);
  }
  if (report.warnings.length > 0) {
    log("warnings:");
    for (const w of report.warnings) {
      log("  " + w);
    }
  } else {
    log("warnings:");
    log("  (none)");
  }
  log("notes:");
  for (const n of report.notes) {
    log("  " + n);
  }
}

// ── Core runner ────────────────────────────────────────────────────────────────

export async function runAllowedRootsHygiene(
  args: HygieneArgs,
  deps: HygieneDeps
): Promise<AllowedRootsHygieneReport> {
  let programPubkey: PublicKey;
  try {
    programPubkey = new PublicKey(args.programId);
  } catch {
    throw new Error(
      "runAllowedRootsHygiene: invalid program ID: " + args.programId
    );
  }

  const [configPdaKey] = deriveConfigPda(programPubkey);
  const configPdaStr = configPdaKey.toBase58();

  const accountInfo = await deps.getAccountInfo(configPdaKey, args.commitment);

  if (accountInfo === null) {
    throw new Error(
      "Config account not found at PDA " +
        configPdaStr +
        ". Verify --program-id and --rpc-url."
    );
  }

  if (
    accountInfo.owner !== undefined &&
    !accountInfo.owner.equals(programPubkey)
  ) {
    throw new Error(
      "verifier_config owner mismatch: expected " +
        programPubkey.toBase58() +
        ", got " +
        accountInfo.owner.toBase58()
    );
  }

  const raw = decodeVerifierConfig(accountInfo.data);
  if (raw === null) {
    throw new Error(
      "Failed to decode verifier_config at " +
        configPdaStr +
        ": discriminator mismatch or unrecognized account size (" +
        accountInfo.data.length +
        " bytes). Verify the program ID."
    );
  }

  const decoded: DecodedAllowedRootsConfig = {
    programId: args.programId,
    configPda: configPdaStr,
    exists: true,
    paused: raw.paused,
    adminAuthority: raw.adminAuthority.toBase58(),
    rootSubmitterAuthority: raw.rootSubmitterAuthority.toBase58(),
    attesterPubkey: raw.attesterPubkey.toBase58(),
    verifierPubkeys: raw.verifierPubkeys.map((p) => p.toBase58()),
    threshold: raw.threshold,
    verifierCount: raw.verifierPubkeys.length,
    allowedRoots: allowedRootsToHex(raw.allowedRoots),
    maxRoots: MAX_ROOTS,
  };

  return buildAllowedRootsHygieneReport(args, decoded);
}

// ── Main runner (testable) ─────────────────────────────────────────────────────

export async function runAllowedRootsHygieneMain(
  argv: string[],
  deps?: AllowedRootsHygieneDeps
): Promise<number> {
  const log = deps?.log ?? console.log.bind(console);
  const warn = deps?.warn ?? console.warn.bind(console);

  let args: HygieneArgs;
  try {
    args = parseHygieneArgs(argv);
  } catch (err) {
    warn((err as Error).message);
    return 1;
  }

  let getAccountInfo: HygieneDeps["getAccountInfo"];
  if (deps?.getAccountInfo !== undefined) {
    getAccountInfo = deps.getAccountInfo;
  } else {
    const connection = new Connection(args.rpcUrl, args.commitment);
    getAccountInfo = async (pda, commitment) => {
      const info = await connection.getAccountInfo(pda, commitment);
      if (info === null) return null;
      return { data: info.data as Buffer, owner: info.owner };
    };
  }

  const runDeps: HygieneDeps = { getAccountInfo };

  let report: AllowedRootsHygieneReport;
  try {
    report = await runAllowedRootsHygiene(args, runDeps);
  } catch (err) {
    warn("error: " + (err as Error).message);
    return 1;
  }

  if (args.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    formatHumanHygieneReport(report, log);
  }

  return 0;
}

// ── Entry point ────────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const code = await runAllowedRootsHygieneMain(process.argv.slice(2));
    process.exit(code);
  })();
}
