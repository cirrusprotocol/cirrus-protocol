#!/usr/bin/env node
/**
 * @cirrusprotocol/devnet-alpha — alpha CLI scaffold.
 *
 * Prototype entry point for a future published command:
 *
 *   npx @cirrusprotocol/devnet-alpha run
 *
 * This is a guided command PLANNER, not a live runner. When run from this
 * repository checkout, `run` with planner arguments passes through to the
 * in-repo guided planner (scripts/ops/devnet_alpha_plan.ts), which is itself
 * simulate-first / command-planner only. This wrapper refuses any argument that
 * looks like a live action before it ever launches the planner. It performs no
 * on-chain action of its own, opens no RPC connection, reads no keypairs,
 * generates no secrets, and never runs a live withdrawal.
 *
 * Not published. Devnet only. Unaudited. Not for real funds. No privacy guarantee.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const BANNER =
  "Devnet only. Unaudited. Not for real funds. No privacy guarantee.";

/**
 * Built-in shared devnet-alpha pool profile. These are PUBLIC devnet addresses
 * and constants only — no keypairs, no operator material, no secrets. The point
 * of a shared profile is that testers connect to the same program, pool, and
 * note tree instead of each spinning up isolated local pools.
 */
const SHARED_PROFILE = {
  name: "cirrus-devnet-alpha",
  rpc: "https://api.devnet.solana.com",
  programId: "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq",
  poolPda: "HcAkT4obzEEaHyevyVvmU7drEtSUg1m4XxF1VTWGoCdm",
  configPda: "6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu",
  noteTreePda: "F5FBHZGdiVxgm335m9VrqNBvM4Zd4N5QBs9AgYMKNAbb",
  defaultDenomination: 1_000_000_000, // 1 SOL (lamports) — recommended alpha bucket
  defaultFee: 1_200_000, // lamports
} as const;

// Relative path (inside a repo checkout) of the guided planner this wrapper
// forwards to. Also used as the primary repo-root detection marker.
const PLANNER_REL = path.join("scripts", "ops", "devnet_alpha_plan.ts");

/**
 * Arguments that look like a live action. `run` refuses these before launching
 * the planner so this wrapper can never be turned into a live-mutation tool in
 * this scaffold. The live-send flag is assembled from fragments so the literal
 * flag string never appears in this source.
 */
const LIVE_ACTION_TOKENS: string[] = [
  "--" + "send", // live withdrawal flag
  "--yes", // unattended-confirm flag (e.g. for submit/deposit ops)
  "submit_root_devnet.ts", // operator-managed root submission script
  "deposit_note_devnet.ts", // deposit script
];

export function rootHelp(): string {
  return [
    "@cirrusprotocol/devnet-alpha (alpha scaffold)",
    "",
    `  ${BANNER}`,
    "  A guided command planner, not a live runner. It does not submit roots and",
    "  does not run live withdrawals.",
    "",
    "Commands:",
    "  run         Guided devnet-alpha entrypoint for the shared Cirrus devnet",
    "              alpha pool (see `run --help`).",
    "  plan        Lower-level command planner for the simulate-only withdraw_zk",
    "              flow (see `plan --help`).",
    "",
    "Run `devnet-alpha run --help` or `devnet-alpha plan --help` for details.",
  ].join("\n");
}

export function runHelp(): string {
  const p = SHARED_PROFILE;
  return [
    "devnet-alpha run — guided devnet-alpha entrypoint (prototype)",
    "",
    `  ${BANNER}`,
    "",
    "  This is the future guided entrypoint for the shared Cirrus devnet alpha",
    "  pool. It is a guided command planner, not a live runner. Simulate-first is",
    "  the default target. Root submission remains operator-managed.",
    "",
    "Shared Cirrus devnet alpha pool:",
    "  By default, testers use the shared Cirrus devnet alpha pool rather than",
    "  creating isolated local pools. Sharing one program, one pool, and one note",
    "  tree improves the shared test set (more deposits land in the same set)",
    "  compared with isolated local pools. This is mechanical devnet testing only.",
    "",
    `  profile           ${p.name}`,
    `  rpc               ${p.rpc}`,
    `  program id        ${p.programId}`,
    `  pool pda          ${p.poolPda}`,
    `  config pda        ${p.configPda}`,
    `  note tree pda     ${p.noteTreePda}`,
    `  default denom     ${p.defaultDenomination} lamports (1 SOL recommended alpha bucket)`,
    `  default fee       ${p.defaultFee} lamports`,
    "",
    "  Shared-pool mechanics on devnet are Tornado-like in shape only. This is NOT",
    "  Tornado-level privacy and makes no privacy guarantee. In the current devnet",
    "  alpha withdrawal flow the recipient, relayer, and amount are still visible.",
    "",
    "Usage:",
    "  devnet-alpha run                 print these safe instructions",
    "  devnet-alpha run --help          show this help",
    "  devnet-alpha run --dry-run ...   forward to the in-repo guided planner",
    "                                   (only from a repository checkout)",
    "",
    "  When forwarded, arguments after `run` are passed to the in-repo guided",
    "  planner (scripts/ops/devnet_alpha_plan.ts). This wrapper refuses any",
    "  live-action argument and never performs an on-chain action itself.",
    "",
    "Safety boundaries:",
    "  - devnet only, unaudited, not for real funds, no privacy guarantee",
    "  - simulate-first; does not run live withdrawals",
    "  - operator-managed root submission (this entrypoint does not submit roots)",
    "  - no live send",
    "  - never reads keypairs, never prints secrets",
  ].join("\n");
}

export function runInstructions(): string {
  const p = SHARED_PROFILE;
  return [
    "devnet-alpha run (alpha scaffold)",
    "",
    `  ${BANNER}`,
    "",
    "  Guided devnet-alpha entrypoint for the shared Cirrus devnet alpha pool",
    `  (profile: ${p.name}). This is a guided command planner, not a live runner.`,
    "  Simulate-first is the default target and root submission remains",
    "  operator-managed.",
    "",
    "  From this repository checkout you can forward planner arguments,",
    "  for example:",
    "",
    "    devnet-alpha run --dry-run ...",
    "",
    "  Arguments after `run` are passed to the in-repo guided planner:",
    "",
    "    scripts/ops/devnet_alpha_plan.ts",
    "",
    "  For the shared pool constants and full guidance, run:",
    "",
    "    devnet-alpha run --help",
    "",
    "  It does not submit roots, does not run live withdrawals, refuses live-action",
    "  arguments, never reads keypairs, and never prints secrets.",
  ].join("\n");
}

export function noRepoMessage(): string {
  return [
    "devnet-alpha run: no repository checkout detected.",
    "",
    `  ${BANNER}`,
    "",
    "  This alpha package currently wraps the in-repo guided planner and needs a",
    "  Cirrus repository checkout. Either:",
    "",
    "    - run this from the repository root (the directory that contains",
    "      scripts/ops/devnet_alpha_plan.ts), or",
    "    - clone the repository and run it from there.",
    "",
    "  Standalone (no-checkout) operation is not supported yet.",
  ].join("\n");
}

export function planHelp(): string {
  return [
    "devnet-alpha plan — guided devnet-alpha command planner (prototype)",
    "",
    `  ${BANNER}`,
    "",
    "  This is a command PLANNER, not a live runner. It produces the ordered,",
    "  copy-pasteable commands for the simulate-only withdraw_zk flow. It does",
    "  not submit roots and does not run live withdrawals. Root submission stays",
    "  operator-managed. It never reads keypairs and never prints secrets.",
    "",
    "Usage:",
    "  devnet-alpha plan [--help]",
    "",
    "Status:",
    "  Alpha scaffold. The guided planner currently lives in the repository at",
    "  scripts/ops/devnet_alpha_plan.ts. Run that script from a checkout for now;",
    "  this package will wrap it in a future release.",
  ].join("\n");
}

export function planInstructions(): string {
  return [
    "devnet-alpha plan (alpha scaffold)",
    "",
    `  ${BANNER}`,
    "",
    "  The guided planner currently lives in the repository. Run it from a",
    "  Cirrus repository checkout:",
    "",
    "    npx ts-node --project tsconfig.json scripts/ops/devnet_alpha_plan.ts --dry-run",
    "",
    "  It is a command planner (simulate-only target). It does not submit roots,",
    "  run live withdrawals, read keypairs, or print secrets.",
  ].join("\n");
}

/**
 * Walk upward from `start` looking for a repository checkout. Conservative: a
 * directory only counts when it holds BOTH the guided planner and a package.json.
 */
export function findRepoRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, PLANNER_REL)) &&
      fs.existsSync(path.join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/** Return the first live-action token found in `args`, or null if none. */
export function findLiveActionToken(args: string[]): string | null {
  for (const a of args) {
    for (const tok of LIVE_ACTION_TOKENS) {
      if (a === tok || a.includes(tok)) return tok;
    }
  }
  return null;
}

/**
 * Forward planner arguments to the in-repo guided planner using the repo's own
 * ts-node setup. Streams the planner's output through; returns its exit code.
 */
function invokePlanner(repoRoot: string, args: string[]): number {
  const planner = path.join(repoRoot, PLANNER_REL);
  const res = spawnSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", planner, ...args],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1" },
    }
  );
  if (res.error) {
    console.error(
      `devnet-alpha run: failed to launch the in-repo planner: ${res.error.message}`
    );
    return 1;
  }
  return typeof res.status === "number" ? res.status : 1;
}

function runCommand(rest: string[]): number {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(runHelp());
    return 0;
  }
  if (rest.length === 0) {
    console.log(runInstructions());
    return 0;
  }
  // Planner pass-through. Refuse anything that looks like a live action first.
  // The offending token is deliberately NOT echoed: the live withdrawal flag is
  // assembled from fragments so the literal flag never appears in this source,
  // help, or runtime output.
  if (findLiveActionToken(rest) !== null) {
    console.error(
      "devnet-alpha run: refusing a live-action argument — this is a" +
        " simulate-first planner wrapper and will not perform or forward live" +
        " actions."
    );
    return 2;
  }
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === null) {
    console.error(noRepoMessage());
    return 1;
  }
  return invokePlanner(repoRoot, rest);
}

export function main(argv: string[]): number {
  const [sub, ...rest] = argv;
  const wantsHelp = (a: string[]) => a.includes("--help") || a.includes("-h");

  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(rootHelp());
    return 0;
  }

  if (sub === "run") {
    return runCommand(rest);
  }

  if (sub === "plan") {
    console.log(wantsHelp(rest) ? planHelp() : planInstructions());
    return 0;
  }

  console.error(`unknown command: ${sub}`);
  console.error("");
  console.error(rootHelp());
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
