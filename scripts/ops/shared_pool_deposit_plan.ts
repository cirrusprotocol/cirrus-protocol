#!/usr/bin/env ts-node
/**
 * scripts/ops/shared_pool_deposit_plan.ts
 *
 * Pure / offline deposit PLANNER for the shared Cirrus devnet alpha pool.
 *
 * It prints the exact, ordered, copy-pasteable commands a tester runs to:
 *   1. generate a note secret locally (outside the repo; the secret is never
 *      printed and is never created by this planner),
 *   2. deposit the resulting commitment into the shared pool (an OPTIONAL,
 *      user-triggered devnet mutation — shown dry-run first, then an explicit
 *      live form),
 *   3. check shared-pool readiness once the operator has submitted the root, and
 *   4. assemble the withdraw_zk --simulate command sequence with the guided
 *      planner (simulate-first).
 *
 * This is a planner, NOT a runner. It is strictly pure / offline:
 *   - Opens no RPC connection and sends no transaction.
 *   - Reads no wallet and no keypairs (it never reads wallet environment variables).
 *   - Creates no secret and prints no secret.
 *   - Spawns no subprocess and never shells out to git.
 *   - Never submits roots and never constructs a live withdrawal. Root submission
 *     is operator-managed; testers do not submit roots.
 *
 * Secret-output safety is fail-closed: a path OUTSIDE the repository is required.
 * Any in-repo path is rejected (this planner does not shell out to git, so it
 * cannot confirm a path is git-ignored and conservatively refuses all in-repo
 * destinations).
 *
 * Usage:
 *   npx ts-node --project tsconfig.json scripts/ops/shared_pool_deposit_plan.ts \
 *     --secret-output <path-outside-repo> [--recipient <pubkey>] \
 *     [--relayer <pubkey>] [--denomination <lamports>] \
 *     [--commitment <processed|confirmed|finalized>] [--json]
 *
 * Exit codes:
 *   0  Plan printed
 *   1  Malformed arguments, non-devnet profile, or unsafe (in-repo) secret-output
 */

import * as path from "path";
import {
  CIRRUS_DEVNET_ALPHA_PROFILE,
  CirrusDevnetAlphaProfile,
} from "./cirrus_devnet_alpha_profile";
import { assertDevnetProfile } from "./shared_pool_status_devnet";
import {
  assertSafeOutputPath,
  parseDenomination,
} from "./generate_note_secret";

const BANNER =
  "Devnet only. Unaudited. Not for real funds. No privacy guarantee.";

const NPX = "npx ts-node --project tsconfig.json";

// Base58 public key shape (no 0/O/I/l), 32–44 chars. Light validation only.
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DepositPlanArgs {
  secretOutput: string;
  recipient?: string;
  relayer?: string;
  denomination: bigint;
  commitmentLevel: "processed" | "confirmed" | "finalized";
  json: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  commands: string[];
  note?: string;
}

export interface DepositPlan {
  profile: {
    name: string;
    rpc: string;
    programId: string;
    poolPda: string;
    configPda: string;
    noteTreePda: string;
    defaultDenomination: number;
    defaultFee: number;
  };
  secretOutput: string;
  denomination: string;
  commitmentLevel: string;
  recipient: string | null;
  relayer: string | null;
  rootSubmission: "operator-managed";
  caveats: string[];
  steps: PlanStep[];
}

// ── Argument parsing ─────────────────────────────────────────────────────────────

const VALUED_FLAGS = new Set([
  "--secret-output",
  "--recipient",
  "--relayer",
  "--denomination",
  "--commitment",
]);
const BOOL_FLAGS = new Set(["--json"]);

export function parseArgs(
  argv: string[],
  defaultDenomination: bigint
): DepositPlanArgs {
  let secretOutput: string | undefined;
  let recipient: string | undefined;
  let relayer: string | undefined;
  let denomination: bigint = defaultDenomination;
  let commitmentLevel: "processed" | "confirmed" | "finalized" = "confirmed";
  let json = false;

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
        case "--secret-output":
          secretOutput = next;
          break;
        case "--recipient":
          if (!BASE58_PUBKEY.test(next)) {
            throw new Error(
              `parseArgs: --recipient is not a base58 public key: ${next}`
            );
          }
          recipient = next;
          break;
        case "--relayer":
          if (!BASE58_PUBKEY.test(next)) {
            throw new Error(
              `parseArgs: --relayer is not a base58 public key: ${next}`
            );
          }
          relayer = next;
          break;
        case "--denomination":
          denomination = parseDenomination(next);
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
          commitmentLevel = next;
          break;
      }
      i += 2;
    } else if (BOOL_FLAGS.has(flag)) {
      if (flag === "--json") json = true;
      i++;
    } else {
      throw new Error(`parseArgs: unknown flag: ${flag}`);
    }
  }

  if (secretOutput === undefined) {
    throw new Error("--secret-output is required");
  }

  return {
    secretOutput,
    recipient,
    relayer,
    denomination,
    commitmentLevel,
    json,
  };
}

// ── Caveats ──────────────────────────────────────────────────────────────────────

export function caveats(): string[] {
  return [
    "Cirrus devnet-alpha shared-pool deposit planner (prototype) — planner only.",
    "  - Devnet only. Not mainnet. No real funds.",
    "  - Unaudited. Single-operator deployment. No privacy guarantee.",
    "  - This planner PRINTS commands; it does not deposit, submit roots, or withdraw.",
    "  - Root submission is operator-managed; this planner never submits roots.",
    "  - The note secret is generated by a separate step, kept outside the repo, never printed.",
  ];
}

// ── Command builders (printed instructions only; never executed by this planner) ─

/** Local note-secret generation. No network, no mutation; writes outside the repo. */
export function buildGenerateCommands(args: DepositPlanArgs): string[] {
  const denom = args.denomination.toString();
  return [
    `${NPX} scripts/ops/generate_note_secret.ts \\\n` +
      `  --secret-output ${args.secretOutput} --denomination ${denom} --dry-run`,
    `${NPX} scripts/ops/generate_note_secret.ts \\\n` +
      `  --secret-output ${args.secretOutput} --denomination ${denom} --yes`,
  ];
}

/**
 * Deposit the commitment into the shared pool. Conservative: the dry-run preview
 * sends nothing; the live form is OPTIONAL, explicit (`--yes`), and user-run.
 */
export function buildDepositCommands(
  profile: CirrusDevnetAlphaProfile,
  args: DepositPlanArgs
): string[] {
  const denom = args.denomination.toString();
  return [
    `${NPX} scripts/ops/deposit_note_devnet.ts \\\n` +
      `  --commitment <COMMITMENT-from-step-1> --denomination ${denom} --dry-run`,
    `ANCHOR_PROVIDER_URL=${profile.rpc} ANCHOR_WALLET=<devnet-wallet> \\\n` +
      `  ${NPX} scripts/ops/deposit_note_devnet.ts \\\n` +
      `  --commitment <COMMITMENT-from-step-1> --denomination ${denom} --yes`,
  ];
}

/** Read-only readiness check (single line so the flag stays adjacent). */
export function buildStatusCommand(args: DepositPlanArgs): string {
  return (
    `${NPX} scripts/ops/shared_pool_status_devnet.ts ` +
    `--expected-root <merkle-root> --commitment ${args.commitmentLevel}`
  );
}

/** Resume shape for the guided planner (simulate-first; no live send). */
export function buildSimulateCommand(args: DepositPlanArgs): string {
  const recipient = args.recipient ?? "<recipient>";
  const relayer = args.relayer ?? "<relayer>";
  return (
    `${NPX} scripts/ops/devnet_alpha_plan.ts --skip-note-generation \\\n` +
    `  --snapshot <snapshot> --leaf-index <n> --root <merkle-root> \\\n` +
    `  --secret-output ${args.secretOutput} --recipient ${recipient} --relayer ${relayer} \\\n` +
    `  --wasm <wasm> --zkey <zkey> --artifact-manifest <artifact-manifest>`
  );
}

// ── Plan builder ─────────────────────────────────────────────────────────────────

/**
 * Builds the full deposit plan. Enforces devnet-only and fail-closed secret-output
 * safety (out-of-repo required). Pure: no I/O, no subprocess, no network.
 */
export function buildDepositPlan(
  profile: CirrusDevnetAlphaProfile,
  args: DepositPlanArgs,
  repoRoot: string
): DepositPlan {
  assertDevnetProfile(profile);

  // Fail-closed: reject any in-repo destination. We never shell out to git, so
  // we cannot confirm a path is git-ignored — an out-of-repo path is required.
  const resolvedSecret = path.resolve(args.secretOutput);
  assertSafeOutputPath(resolvedSecret, repoRoot, () => false);

  const resolvedArgs: DepositPlanArgs = {
    ...args,
    secretOutput: resolvedSecret,
  };

  return {
    profile: {
      name: profile.name,
      rpc: profile.rpc,
      programId: profile.programId,
      poolPda: profile.poolPda,
      configPda: profile.configPda,
      noteTreePda: profile.noteTreePda,
      defaultDenomination: profile.defaultDenomination,
      defaultFee: profile.defaultFee,
    },
    secretOutput: resolvedSecret,
    denomination: resolvedArgs.denomination.toString(),
    commitmentLevel: resolvedArgs.commitmentLevel,
    recipient: resolvedArgs.recipient ?? null,
    relayer: resolvedArgs.relayer ?? null,
    rootSubmission: "operator-managed",
    caveats: caveats(),
    steps: [
      {
        id: "generate-note-secret",
        title:
          "Generate the note secret locally (writes a 0600 file OUTSIDE the repo; the secret is never printed)",
        commands: buildGenerateCommands(resolvedArgs),
        note: "Run --dry-run first to confirm the path, then --yes to generate. The --yes run prints the public COMMITMENT used in step 2. Keep the secret file; never commit or share it.",
      },
      {
        id: "deposit",
        title:
          "Deposit the commitment into the shared pool (OPTIONAL, user-triggered devnet mutation)",
        commands: buildDepositCommands(profile, resolvedArgs),
        note: "The dry-run preview sends nothing. The live deposit is OPTIONAL and user-triggered — the planner does not run it. Use the recommended 1 SOL devnet bucket.",
      },
      {
        id: "status-readiness",
        title:
          "After the operator submits your Merkle root, check shared-pool readiness (read-only)",
        commands: [buildStatusCommand(resolvedArgs)],
        note: "Adding the Merkle root to the on-chain allowlist is operator-managed — testers do not submit roots. If your root is not present, ask the operator. Readiness means the root is allow-listed for the simulate flow.",
      },
      {
        id: "simulate",
        title:
          "Once your root is allow-listed, assemble the withdraw_zk --simulate sequence (simulate-first)",
        commands: [buildSimulateCommand(resolvedArgs)],
        note: "The guided planner stops at --simulate; it never runs a live withdrawal. See `devnet-alpha plan --help`.",
      },
    ],
  };
}

// ── Output formatting ────────────────────────────────────────────────────────────

export function formatPlanHuman(plan: DepositPlan): string {
  const lines: string[] = [];
  lines.push("Shared pool deposit plan — Cirrus devnet alpha");
  lines.push("");
  for (const c of plan.caveats) lines.push(c);
  lines.push("");

  const W = 16;
  const row = (k: string, v: string): void => {
    lines.push(`  ${k.padEnd(W)} ${v}`);
  };
  lines.push("Shared pool profile:");
  row("profile", plan.profile.name);
  row("rpc", plan.profile.rpc);
  row("program id", plan.profile.programId);
  row("pool pda", plan.profile.poolPda);
  row("config pda", plan.profile.configPda);
  row("note tree pda", plan.profile.noteTreePda);
  row("default denom", `${plan.profile.defaultDenomination} lamports`);
  row("default fee", `${plan.profile.defaultFee} lamports`);
  lines.push("");
  row("secret-output", plan.secretOutput);
  row("denomination", `${plan.denomination} lamports`);
  lines.push("");

  plan.steps.forEach((s, i) => {
    lines.push(`Step ${i + 1}. ${s.title}`);
    for (const cmd of s.commands) {
      for (const cl of cmd.split("\n")) lines.push(`  ${cl}`);
      lines.push("");
    }
    if (s.note !== undefined) {
      lines.push(`  ${s.note}`);
      lines.push("");
    }
  });

  lines.push(
    `Root submission: ${plan.rootSubmission} (testers do not submit roots).`
  );
  return lines.join("\n");
}

export function formatPlanJson(plan: DepositPlan): string {
  return JSON.stringify(plan, null, 2);
}

// ── Help ───────────────────────────────────────────────────────────────────────

export function depositPlanHelp(): string {
  return [
    "shared_pool_deposit_plan.ts — pure/offline shared-pool deposit planner",
    "",
    `  ${BANNER}`,
    "",
    "  Prints the exact, ordered commands to deposit into the shared Cirrus devnet",
    "  alpha pool and then check readiness. It is a planner, not a runner: it opens",
    "  no RPC connection, reads no wallet or keypairs, sends no transactions, creates",
    "  no secret, and never submits roots. Root submission is operator-managed.",
    "",
    "Usage:",
    "  npx ts-node --project tsconfig.json scripts/ops/shared_pool_deposit_plan.ts \\",
    "    --secret-output <path-outside-repo> [options]",
    "",
    "Options:",
    "  --secret-output <path>     Required. Where the later generate step will write",
    "                             the note secret. Must be OUTSIDE the repository.",
    "  --recipient <pubkey>       Optional. Fills the later simulate command",
    "                             (placeholder if omitted).",
    "  --relayer <pubkey>         Optional. Fills the later simulate command",
    "                             (placeholder if omitted).",
    "  --denomination <lamports>  Optional. Deposit amount; default 1000000000 (1 SOL).",
    "  --commitment <level>       processed | confirmed | finalized (default confirmed).",
    "  --json                     Emit JSON instead of human-readable text.",
    "  --help                     Show this help and exit.",
  ].join("\n");
}

// ── CLI entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(depositPlanHelp());
    process.exit(0);
  }

  const profile = CIRRUS_DEVNET_ALPHA_PROFILE;

  let args: DepositPlanArgs;
  try {
    args = parseArgs(argv, BigInt(profile.defaultDenomination));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, "..", "..");

  let plan: DepositPlan;
  try {
    plan = buildDepositPlan(profile, args, repoRoot);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  console.log(args.json ? formatPlanJson(plan) : formatPlanHuman(plan));
  process.exit(0);
}
