#!/usr/bin/env ts-node
/**
 * scripts/ops/shared_pool_status_devnet.ts
 *
 * Read-only status / readiness for the shared Cirrus devnet alpha pool.
 *
 * Prints the public shared-pool profile (program, pool, config, and note-tree
 * PDAs, default denomination and fee) and — unless --offline — reads the on-chain
 * verifier_config (read-only) to report the allowed-root count and, when an
 * --expected-root is supplied, whether that root is allow-listed yet. That last
 * check is the tester's "ready to reach withdraw_zk --simulate" signal.
 *
 * This script is strictly read-only:
 *   - Requires no wallet and reads no keypairs (it does not touch ANCHOR_WALLET).
 *   - Opens at most one read-only RPC connection and calls getAccountInfo only.
 *   - Sends no transactions and constructs no deposit / withdraw / submit command.
 *   - Never submits roots. Root submission is operator-managed; testers do not
 *     submit roots. If an expected root is not present, ask the operator.
 *
 * Root presence is not ZK proof verification. It only confirms the root is
 * registered in the on-chain allowed_roots list.
 *
 * Usage:
 *   npx ts-node scripts/ops/shared_pool_status_devnet.ts [--offline] \
 *     [--expected-root <64-hex>] [--commitment confirmed] [--json]
 *
 * Exit codes:
 *   0  Offline print, OR config exists and (no expected root, or root present)
 *   1  Malformed arguments, config missing / query failed, or expected root absent
 */

import { Connection, Commitment } from "@solana/web3.js";
import {
  CIRRUS_DEVNET_ALPHA_PROFILE,
  CirrusDevnetAlphaProfile,
} from "./cirrus_devnet_alpha_profile";
import {
  runInspect,
  validateRootHex,
  InspectDeps,
  VerifierConfigSummary,
} from "./inspect_allowed_roots_devnet";

const BANNER =
  "Devnet only. Unaudited. Not for real funds. No privacy guarantee.";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface StatusArgs {
  expectedRoot?: string;
  commitment: "processed" | "confirmed" | "finalized";
  offline: boolean;
  json: boolean;
  /** Optional devnet RPC override; when omitted the profile RPC is used. */
  rpcUrl?: string;
}

export interface SharedPoolStatus {
  profile: string;
  rpc: string;
  programId: string;
  poolPda: string;
  configPda: string;
  noteTreePda: string;
  defaultDenomination: number;
  defaultFee: number;
  /** Always operator-managed in this alpha; testers never submit roots. */
  rootSubmission: "operator-managed";
  offline: boolean;
  // network-derived (only when online and the config was readable)
  configExists?: boolean;
  paused?: boolean;
  allowedRootCount?: number;
  maxRoots?: number;
  expectedRoot?: string;
  expectedRootPresent?: boolean;
  /** Readiness to reach withdraw_zk --simulate for the given expected root. */
  ready?: boolean;
  // Root capacity diagnostics (derived from allowedRootCount/maxRoots).
  remainingRootSlots?: number;
  rootCapacityUsedPercent?: number;
  rootCapacitySeverity?: RootCapacitySeverity;
  rootCapacityWarning?: string;
  /** Human-readable note (offline, query error, or not-ready reason). */
  note?: string;
}

// ── Root capacity diagnostics (pure) ─────────────────────────────────────────────

export type RootCapacitySeverity = "ok" | "warning" | "critical";

/** Remaining-slot threshold at or below which capacity is reported as low. */
export const ROOT_CAPACITY_WARNING_THRESHOLD = 3;

export interface RootCapacity {
  remainingRootSlots: number;
  rootCapacityUsedPercent: number;
  rootCapacitySeverity: RootCapacitySeverity;
  rootCapacityWarning?: string;
}

/**
 * Evaluates on-chain allowed-root capacity. Pure and side-effect free.
 *
 * Severity:
 *   - critical  no slots remain (or capacity is unavailable/exhausted)
 *   - warning   ROOT_CAPACITY_WARNING_THRESHOLD or fewer slots remain
 *   - ok        otherwise
 *
 * This is an alpha operational warning, not a security finding by itself: root
 * submission is operator-managed, and a full allowlist means operator root
 * rotation or capacity policy is required before new tester roots can be added.
 */
export function evaluateRootCapacity(params: {
  allowedRootCount: number;
  maxRoots: number;
}): RootCapacity {
  const used = Math.max(0, params.allowedRootCount);
  const max = params.maxRoots;

  if (!Number.isFinite(max) || max <= 0) {
    return {
      remainingRootSlots: 0,
      rootCapacityUsedPercent: 100,
      rootCapacitySeverity: "critical",
      rootCapacityWarning:
        `Root capacity unavailable: maxRoots=${String(max)}. ` +
        `No root slots can be reported; treat as exhausted.`,
    };
  }

  // Clamp so an over-full list (used > max) reports safely as exhausted.
  const remaining = Math.max(0, max - used);
  const usedPercent = Math.min(100, Math.round((used / max) * 100));
  const slotPhrase =
    remaining === 1 ? "1 slot remains" : `${remaining} slots remain`;
  const usedLabel = `${used}/${max} allowed roots used; ${slotPhrase}`;

  if (remaining <= 0) {
    return {
      remainingRootSlots: 0,
      rootCapacityUsedPercent: usedPercent,
      rootCapacitySeverity: "critical",
      rootCapacityWarning:
        `Root capacity exhausted: ${usedLabel}. Operator root rotation or ` +
        `capacity policy is required before new tester roots can be allow-listed.`,
    };
  }

  if (remaining <= ROOT_CAPACITY_WARNING_THRESHOLD) {
    return {
      remainingRootSlots: remaining,
      rootCapacityUsedPercent: usedPercent,
      rootCapacitySeverity: "warning",
      rootCapacityWarning:
        `Root capacity is low: ${usedLabel}. Root submission is ` +
        `operator-managed — plan root rotation before inviting more testers.`,
    };
  }

  return {
    remainingRootSlots: remaining,
    rootCapacityUsedPercent: usedPercent,
    rootCapacitySeverity: "ok",
  };
}

// ── Devnet-only guard ────────────────────────────────────────────────────────────

/**
 * Refuses to operate on any profile that is not clearly a devnet endpoint. This
 * is a status/readiness tool for the shared Cirrus devnet alpha pool only; it
 * must never be pointed at mainnet (and there is no real-funds path here).
 */
export function assertDevnetProfile(profile: CirrusDevnetAlphaProfile): void {
  const rpc = profile.rpc.toLowerCase();
  if (rpc.includes("mainnet")) {
    throw new Error(
      `refusing a non-devnet RPC (looks like mainnet): ${profile.rpc}`
    );
  }
  if (!rpc.includes("devnet")) {
    throw new Error(
      `refusing a non-devnet RPC (expected a devnet endpoint): ${profile.rpc}`
    );
  }
}

/**
 * Returns the profile to operate on. With an explicit --rpc-url override the
 * profile's RPC endpoint is replaced (all other public constants are kept); the
 * override is still subject to the devnet-only guard. Without an override the
 * canonical profile is returned unchanged. Pure and side-effect free.
 */
export function resolveProfile(
  profile: CirrusDevnetAlphaProfile,
  rpcUrl?: string
): CirrusDevnetAlphaProfile {
  return rpcUrl ? { ...profile, rpc: rpcUrl } : profile;
}

// ── Report builder (pure) ────────────────────────────────────────────────────────

/**
 * Merges the static profile with an optional on-chain verifier_config summary
 * into a single status report. Pure and side-effect free.
 *
 *   - offline: print the static profile only; no readiness is computed.
 *   - queryError: the chain read failed; report it without inventing readiness.
 *   - summary: the read-only verifier_config summary from runInspect.
 */
export function buildStatusReport(
  profile: CirrusDevnetAlphaProfile,
  opts: {
    offline: boolean;
    expectedRoot?: string;
    summary?: VerifierConfigSummary | null;
    queryError?: string;
  }
): SharedPoolStatus {
  const status: SharedPoolStatus = {
    profile: profile.name,
    rpc: profile.rpc,
    programId: profile.programId,
    poolPda: profile.poolPda,
    configPda: profile.configPda,
    noteTreePda: profile.noteTreePda,
    defaultDenomination: profile.defaultDenomination,
    defaultFee: profile.defaultFee,
    rootSubmission: "operator-managed",
    offline: opts.offline,
  };

  if (opts.offline) {
    status.note =
      "offline: static profile only; the on-chain config was not queried.";
    // Echo the requested root (lowercased) but assert no presence/readiness:
    // nothing was read from the chain, so those verdicts stay undefined.
    if (opts.expectedRoot !== undefined) {
      status.expectedRoot = opts.expectedRoot.toLowerCase();
    }
    return status;
  }

  if (opts.queryError !== undefined) {
    status.note = `on-chain config query failed: ${opts.queryError}`;
    return status;
  }

  const summary = opts.summary;
  if (summary === undefined || summary === null) {
    status.note = "on-chain config unavailable.";
    return status;
  }

  status.configExists = summary.exists;
  if (!summary.exists) {
    status.note =
      "verifier_config account not found at the configured PDA — the shared pool is not ready.";
    if (opts.expectedRoot !== undefined) {
      status.expectedRoot = opts.expectedRoot.toLowerCase();
      status.expectedRootPresent = false;
      status.ready = false;
    }
    return status;
  }

  status.paused = summary.paused;
  status.allowedRootCount = summary.allowedRootCount;
  status.maxRoots = summary.maxRoots;

  if (
    summary.allowedRootCount !== undefined &&
    summary.maxRoots !== undefined
  ) {
    const capacity = evaluateRootCapacity({
      allowedRootCount: summary.allowedRootCount,
      maxRoots: summary.maxRoots,
    });
    status.remainingRootSlots = capacity.remainingRootSlots;
    status.rootCapacityUsedPercent = capacity.rootCapacityUsedPercent;
    status.rootCapacitySeverity = capacity.rootCapacitySeverity;
    if (capacity.rootCapacityWarning !== undefined) {
      status.rootCapacityWarning = capacity.rootCapacityWarning;
    }
  }

  if (opts.expectedRoot !== undefined) {
    status.expectedRoot =
      summary.expectedRoot ?? opts.expectedRoot.toLowerCase();
    status.expectedRootPresent = summary.expectedRootPresent;
    status.ready =
      summary.exists === true &&
      summary.paused === false &&
      summary.expectedRootPresent === true;
  }

  return status;
}

// ── Runner ───────────────────────────────────────────────────────────────────────

/**
 * Produces the status report. In offline mode it never touches the network. In
 * online mode it performs a single read-only verifier_config read via runInspect
 * (which only calls deps.getAccountInfo — no wallet, no keypair, no transaction).
 */
export async function runStatus(
  profile: CirrusDevnetAlphaProfile,
  args: StatusArgs,
  deps: InspectDeps
): Promise<SharedPoolStatus> {
  assertDevnetProfile(profile);

  if (args.offline) {
    return buildStatusReport(profile, {
      offline: true,
      expectedRoot: args.expectedRoot,
    });
  }

  try {
    const summary = await runInspect(
      {
        rpcUrl: profile.rpc,
        programId: profile.programId,
        configPda: profile.configPda,
        expectedRoot: args.expectedRoot,
        commitment: args.commitment,
        json: false,
      },
      deps
    );
    return buildStatusReport(profile, {
      offline: false,
      expectedRoot: args.expectedRoot,
      summary,
    });
  } catch (err) {
    return buildStatusReport(profile, {
      offline: false,
      expectedRoot: args.expectedRoot,
      queryError: (err as Error).message,
    });
  }
}

// ── Output formatting ────────────────────────────────────────────────────────────

export function formatStatusHuman(s: SharedPoolStatus): string {
  const lines: string[] = [];
  const W = 20;
  const row = (k: string, v: string): void => {
    lines.push(`${k.padEnd(W)} ${v}`);
  };

  lines.push("Shared pool status — Cirrus devnet alpha");
  lines.push("");
  lines.push(`  ${BANNER}`);
  lines.push("  Read-only. No wallet, no keypairs, no transactions.");
  lines.push("");
  row("Profile:", s.profile);
  row("RPC:", s.rpc);
  row("Program ID:", s.programId);
  row("Pool PDA:", s.poolPda);
  row("Config PDA:", s.configPda);
  row("Note tree PDA:", s.noteTreePda);
  row(
    "Default denom:",
    `${s.defaultDenomination} lamports (1 SOL recommended alpha bucket)`
  );
  row("Default fee:", `${s.defaultFee} lamports`);
  row("Root submission:", "operator-managed (testers do not submit roots)");

  if (s.offline) {
    lines.push("");
    lines.push(
      "Offline: static profile only; the on-chain config was not queried."
    );
    return lines.join("\n");
  }

  lines.push("");

  // Config missing or query failed: report and stop.
  if (s.configExists !== true) {
    lines.push(s.note ?? "on-chain config unavailable.");
    if (s.expectedRoot !== undefined) {
      row("Expected root:", s.expectedRoot);
      row("Root present:", String(s.expectedRootPresent));
      row("Ready:", String(s.ready));
    }
    return lines.join("\n");
  }

  row("Config exists:", String(s.configExists));
  if (s.paused !== undefined) row("Paused:", String(s.paused));
  if (s.allowedRootCount !== undefined && s.maxRoots !== undefined) {
    row("Allowed roots:", `${s.allowedRootCount}/${s.maxRoots}`);
  }
  if (s.remainingRootSlots !== undefined) {
    row(
      "Root slots left:",
      `${s.remainingRootSlots} (${s.rootCapacityUsedPercent}% used, ${s.rootCapacitySeverity})`
    );
  }
  if (s.rootCapacityWarning !== undefined) {
    lines.push("");
    lines.push(`  [${s.rootCapacitySeverity}] ${s.rootCapacityWarning}`);
  }

  if (s.expectedRoot !== undefined) {
    lines.push("");
    row("Expected root:", s.expectedRoot);
    row("Root present:", String(s.expectedRootPresent));
    row("Ready to simulate:", String(s.ready));
    if (s.ready !== true) {
      lines.push("");
      lines.push(
        "Not ready: the expected root is operator-managed. If it is not present, " +
          "ask the operator to submit it — this tool never submits roots."
      );
    }
  } else {
    lines.push("");
    lines.push(
      "Pass --expected-root <64-hex> to check whether the root for your withdrawal " +
        "is allow-listed yet (your readiness for withdraw_zk --simulate). Root " +
        "submission is operator-managed."
    );
  }

  return lines.join("\n");
}

export function formatStatusJson(s: SharedPoolStatus): string {
  return JSON.stringify(s, null, 2);
}

// ── Help ───────────────────────────────────────────────────────────────────────

export function statusHelp(): string {
  const p = CIRRUS_DEVNET_ALPHA_PROFILE;
  return [
    "shared_pool_status_devnet.ts — read-only shared-pool status / readiness",
    "",
    `  ${BANNER}`,
    "",
    "  Prints the shared Cirrus devnet alpha pool profile and, unless --offline,",
    "  reads the on-chain verifier_config (read-only) to report the allowed-root",
    "  count and whether a given root is allow-listed. It requires no wallet,",
    "  reads no keypairs, sends no transactions, and never submits roots — root",
    "  submission is operator-managed.",
    "",
    "Usage:",
    "  npx ts-node scripts/ops/shared_pool_status_devnet.ts [options]",
    "",
    "Options:",
    "  --rpc-url <url>            Override the devnet RPC endpoint (default: profile RPC).",
    "  --expected-root <64-hex>   Check whether this root is allow-listed (readiness).",
    "  --commitment <level>       processed | confirmed | finalized (default confirmed).",
    "  --offline                  Print the static profile only; do not query the chain.",
    "  --json                     Emit JSON instead of human-readable text.",
    "  --help                     Show this help and exit.",
    "",
    `Profile (public devnet constants): ${p.name} @ ${p.rpc}`,
  ].join("\n");
}

// ── Argument parsing ─────────────────────────────────────────────────────────────

const VALUED_FLAGS = new Set(["--rpc-url", "--expected-root", "--commitment"]);
const BOOL_FLAGS = new Set(["--offline", "--json"]);

export function parseArgs(argv: string[]): StatusArgs {
  let expectedRoot: string | undefined;
  let commitment: "processed" | "confirmed" | "finalized" = "confirmed";
  let offline = false;
  let json = false;
  let rpcUrl: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (VALUED_FLAGS.has(flag)) {
      const next = argv[i + 1];
      if (
        next === undefined ||
        VALUED_FLAGS.has(next) ||
        BOOL_FLAGS.has(next)
      ) {
        throw new Error(
          `parseArgs: ${flag} requires a value but none was provided`
        );
      }
      switch (flag) {
        case "--rpc-url":
          rpcUrl = next;
          break;
        case "--expected-root":
          validateRootHex(next, "--expected-root");
          expectedRoot = next.toLowerCase();
          break;
        case "--commitment":
          if (
            next !== "processed" &&
            next !== "confirmed" &&
            next !== "finalized"
          ) {
            throw new Error(
              `parseArgs: --commitment must be processed, confirmed, or finalized; got: ${next}`
            );
          }
          commitment = next;
          break;
      }
      i += 2;
    } else if (BOOL_FLAGS.has(flag)) {
      if (flag === "--offline") offline = true;
      if (flag === "--json") json = true;
      i++;
    } else {
      throw new Error(`parseArgs: unknown flag: ${flag}`);
    }
  }

  return { expectedRoot, commitment, offline, json, rpcUrl };
}

// ── CLI entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);

    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(statusHelp());
      process.exit(0);
    }

    let args: StatusArgs;
    try {
      args = parseArgs(argv);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    // An optional --rpc-url override replaces only the endpoint; the resolved
    // profile is still subject to the devnet-only guard below.
    const profile = resolveProfile(CIRRUS_DEVNET_ALPHA_PROFILE, args.rpcUrl);

    try {
      assertDevnetProfile(profile);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    // Offline path: never opens a connection.
    if (args.offline) {
      const status = buildStatusReport(profile, {
        offline: true,
        expectedRoot: args.expectedRoot,
      });
      console.log(
        args.json ? formatStatusJson(status) : formatStatusHuman(status)
      );
      process.exit(0);
    }

    // Online path: a single read-only RPC connection; getAccountInfo only.
    const connection = new Connection(profile.rpc, args.commitment);
    const deps: InspectDeps = {
      getAccountInfo: async (pda, commitment) => {
        const info = await connection.getAccountInfo(
          pda,
          commitment as Commitment
        );
        if (info === null) return null;
        return { data: info.data as Buffer, owner: info.owner };
      },
    };

    const status = await runStatus(profile, args, deps);
    console.log(
      args.json ? formatStatusJson(status) : formatStatusHuman(status)
    );

    if (status.configExists !== true) {
      process.exit(1); // config missing or query failed
    }
    if (status.expectedRoot !== undefined && status.ready !== true) {
      process.exit(1); // expected root not present / not ready
    }
    process.exit(0);
  })();
}
