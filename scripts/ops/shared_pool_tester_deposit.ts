#!/usr/bin/env ts-node
/**
 * Guided shared-pool deposit for devnet-alpha testers.
 *
 * One clear entrypoint that lets an external tester deposit devnet SOL into the
 * shared Cirrus devnet-alpha pool from their own devnet keypair wallet, without
 * having to discover and chain several scripts by hand. It reuses the existing
 * safe pieces:
 *   - the canonical devnet-alpha profile (cirrus_devnet_alpha_profile.ts)
 *   - the note generator (generate_note_secret.ts: generateAndWriteNote)
 *   - the existing deposit script (deposit_note_devnet.ts), invoked unchanged so
 *     the on-chain transaction semantics are identical.
 *
 * Devnet alpha only. Not mainnet. Not a browser/Phantom wallet. Not a live
 * withdrawal. No privacy guarantee.
 *
 * Default mode is PREVIEW (dry-run): it validates inputs and explains what would
 * happen but signs nothing, sends nothing, and writes no note secret. A live
 * devnet deposit requires explicit --yes.
 *
 * This script never prints the raw note secret (only the public commitment and
 * nullifier hash) and never prints wallet secret-key contents.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { CIRRUS_DEVNET_ALPHA_PROFILE } from "./cirrus_devnet_alpha_profile";
import {
  assertSafeOutputPath,
  generateAndWriteNote,
} from "./generate_note_secret";

// ── Args ─────────────────────────────────────────────────────────────────────

export interface TesterDepositArgs {
  wallet?: string;
  noteOutput: string;
  rpc: string;
  denomination: number;
  dryRun: boolean;
  yes: boolean;
}

const INT_RE = /^[0-9]+$/;

export function parseArgs(argv: string[]): TesterDepositArgs {
  let wallet: string | undefined;
  let noteOutput: string | undefined;
  let rpc = CIRRUS_DEVNET_ALPHA_PROFILE.rpc;
  let denomination = CIRRUS_DEVNET_ALPHA_PROFILE.defaultDenomination;
  let dryRun = false;
  let yes = false;

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
      case "--wallet":
        wallet = need(i, flag);
        i++;
        break;
      case "--note-output":
        noteOutput = need(i, flag);
        i++;
        break;
      case "--rpc":
        rpc = need(i, flag);
        i++;
        break;
      case "--denomination": {
        const raw = need(i, flag);
        if (!INT_RE.test(raw)) {
          throw new Error(
            "--denomination must be a non-negative integer (lamports)"
          );
        }
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new Error(
            "--denomination must be a positive integer within the safe integer range"
          );
        }
        denomination = value;
        i++;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--yes":
        yes = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }

  if (noteOutput === undefined) {
    throw new Error("--note-output is required");
  }
  if (dryRun && yes) {
    throw new Error("--dry-run and --yes are mutually exclusive");
  }

  return { wallet, noteOutput, rpc, denomination, dryRun, yes };
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Resolves the depositor wallet from --wallet or ANCHOR_WALLET. */
export function resolveWallet(
  args: TesterDepositArgs,
  env: NodeJS.ProcessEnv
): string {
  const fromArg = args.wallet;
  const fromEnv = env.ANCHOR_WALLET;
  const wallet = fromArg ?? fromEnv;
  if (wallet === undefined || wallet.trim() === "") {
    throw new Error(
      "no devnet wallet: pass --wallet <devnet-keypair-path> or set ANCHOR_WALLET"
    );
  }
  return wallet;
}

/**
 * Devnet-only RPC guard. Accepts the canonical devnet-alpha endpoint and any URL
 * that clearly identifies as devnet; rejects mainnet/testnet and any endpoint that
 * does not clearly identify as devnet. (A broader custom-RPC policy, if ever
 * wanted, belongs behind an explicit separate flag in a future change.)
 */
export function assertDevnetRpc(rpc: string): void {
  if (rpc === CIRRUS_DEVNET_ALPHA_PROFILE.rpc) {
    return;
  }
  const lower = rpc.toLowerCase();
  if (lower.includes("mainnet") || lower.includes("testnet")) {
    throw new Error(
      `RPC is not a devnet endpoint (${rpc}); this guided deposit is devnet-alpha only`
    );
  }
  if (!lower.includes("devnet")) {
    throw new Error(
      `RPC does not clearly identify as devnet (${rpc}); this guided deposit is ` +
        `devnet-alpha only. Use ${CIRRUS_DEVNET_ALPHA_PROFILE.rpc} or a clearly-devnet endpoint.`
    );
  }
}

/** Rejects a note-output path inside the repository (delegates to the tested guard). */
export function assertNoteOutputOutsideRepo(
  noteOutput: string,
  repoRoot: string,
  isGitIgnored: (absPath: string) => boolean
): void {
  assertSafeOutputPath(noteOutput, repoRoot, isGitIgnored);
}

// ── Command construction (pure; never executed by these functions) ───────────

const NPX = ["ts-node", "--project", "tsconfig.json"];
const DEPOSIT_SCRIPT = "scripts/ops/deposit_note_devnet.ts";

export interface DepositCommand {
  bin: string;
  argv: string[];
  env: Record<string, string>;
}

/**
 * Builds the invocation of the existing deposit script for the live --yes path.
 * Returns argv + env only; it does not run anything. The transaction is produced
 * entirely by deposit_note_devnet.ts, so its on-chain semantics are unchanged.
 */
export function buildDepositCommand(params: {
  rpc: string;
  walletPath: string;
  commitmentHex: string;
  denomination: number;
}): DepositCommand {
  return {
    bin: "npx",
    argv: [
      ...NPX,
      DEPOSIT_SCRIPT,
      "--commitment",
      params.commitmentHex,
      "--denomination",
      String(params.denomination),
      "--yes",
    ],
    env: {
      ANCHOR_PROVIDER_URL: params.rpc,
      ANCHOR_WALLET: params.walletPath,
    },
  };
}

// ── Human-readable pieces ────────────────────────────────────────────────────

export function noteSecretWarnings(): string[] {
  return [
    "Note secret safety:",
    "  - Losing the note secret means this deposit can NEVER be withdrawn.",
    "  - Sharing the note secret lets anyone spend the note.",
    "  - The secret file is written outside the repo (0600) and is never printed.",
    "  - Devnet alpha has no privacy guarantee; recipient, relayer, and amount are public.",
  ];
}

export function nextSteps(): string[] {
  return [
    "Next steps (after a real --yes deposit):",
    "  1. Root submission is operator-managed — ask the operator to derive and",
    "     submit your Merkle root. Testers do not submit roots.",
    "  2. Once the root is submitted, check readiness:",
    "       npx ts-node --project tsconfig.json scripts/ops/shared_pool_status_devnet.ts \\",
    "         --expected-root <root>",
    "  3. Run privacy diagnostics before any witness / proof / simulate step:",
    "       npx ts-node --project tsconfig.json scripts/ops/shared_pool_privacy_diagnostics.ts \\",
    "         --snapshot <snapshot> --leaf-index <n>",
    "  4. Do not run a live withdrawal unless explicitly intended; the target is",
    "     simulate-first.",
  ];
}

export function helpText(): string {
  return [
    "shared_pool_tester_deposit.ts — guided shared-pool deposit for devnet-alpha testers.",
    "",
    "Deposit devnet SOL into the shared Cirrus devnet-alpha pool from your own devnet",
    "keypair wallet, in one step, without hunting through multiple scripts.",
    "",
    "Devnet alpha only. Not mainnet. Not a browser/Phantom wallet. Not a live",
    "withdrawal. No privacy guarantee.",
    "",
    "By default this runs in PREVIEW (dry-run): it validates your inputs and explains",
    "what would happen, but signs nothing, sends no transaction, and writes no note",
    "secret. A live devnet deposit requires explicit --yes.",
    "",
    "The raw note secret is NEVER printed (only the public commitment and nullifier",
    "hash are). Your wallet secret key is NEVER printed or logged.",
    "",
    "Usage (recommended tester form — the silent npm run avoids npm echoing your",
    "wallet/note paths before the script can redact them):",
    "  npm run --silent alpha:deposit -- \\",
    "    --wallet <devnet-keypair-path> --note-output <outside-repo-path> [options]",
    "  # or set ANCHOR_WALLET instead of --wallet",
    "",
    "Required:",
    "  --wallet <path>            Devnet keypair to deposit from (or set ANCHOR_WALLET).",
    "  --note-output <path>       Where to write the new note secret (MUST be outside the repo).",
    "",
    "Optional:",
    "  --rpc <url>                Devnet RPC (default: https://api.devnet.solana.com).",
    "                             Non-devnet endpoints (mainnet/testnet/unknown) are rejected.",
    "  --denomination <lamports>  Deposit amount (default: 1000000000 = 1 SOL).",
    "  --dry-run                  Preview only (this is also the default).",
    "  --yes                      Perform the live devnet deposit (sign + send exactly one tx).",
    "  --help, -h                 Print this help and exit.",
    "",
    "A live deposit (--yes) will:",
    "  - generate a fresh note secret to --note-output (0600, never printed)",
    "  - send exactly one depositNote transaction via scripts/ops/deposit_note_devnet.ts",
    "  - print public-safe values only: depositor, commitment, nullifier hash,",
    "    denomination, transaction signature, and leaf index",
    "",
    "Keep your note secret: losing it means the deposit can never be withdrawn; sharing",
    "it lets anyone spend the note. Devnet alpha has no privacy guarantee.",
    "",
    "Examples (use the silent npm form — it does not echo your paths):",
    "  # Preview (default — no signing, no send, no note written):",
    "  npm run --silent alpha:deposit -- \\",
    "    --wallet <devnet-keypair-path> --note-output <outside-repo-path>",
    "",
    "  # Live devnet deposit of 1 SOL:",
    "  npm run --silent alpha:deposit -- \\",
    "    --wallet <devnet-keypair-path> --note-output <outside-repo-path> --yes",
    "",
    "  # Maintainers may also invoke the script directly:",
    "  npx ts-node --project tsconfig.json scripts/ops/shared_pool_tester_deposit.ts \\",
    "    --wallet <devnet-keypair-path> --note-output <outside-repo-path>",
  ].join("\n");
}

/**
 * Renders the preview (dry-run / default) plan. Writes nothing, sends nothing,
 * and does not echo concrete wallet/note paths — only the resolved wallet source
 * and the public devnet constants.
 */
export function formatDryRun(
  args: TesterDepositArgs,
  walletSource: string
): string {
  // Placeholder wallet on purpose: the real path is never echoed. The deposit
  // argv does not contain the wallet (it is passed via ANCHOR_WALLET env).
  const cmd = buildDepositCommand({
    rpc: args.rpc,
    walletPath: "<your-wallet>",
    commitmentHex: "<commitment-generated-in-a-real-run>",
    denomination: args.denomination,
  });
  const lines: string[] = [];
  lines.push(
    "Guided shared pool tester deposit — Cirrus devnet alpha (PREVIEW)"
  );
  lines.push("");
  lines.push(
    "  Devnet alpha only. Unaudited. Not for real funds. No privacy guarantee."
  );
  lines.push("");
  lines.push("Inputs (validated):");
  lines.push(`  rpc:           ${args.rpc}`);
  lines.push(
    `  program id:    ${CIRRUS_DEVNET_ALPHA_PROFILE.programId} (canonical devnet-alpha pool)`
  );
  lines.push(
    `  wallet:        resolved via ${walletSource} (path not shown; contents never read)`
  );
  lines.push(
    "  note output:   accepted — outside the repository (path not shown)"
  );
  lines.push(`  denomination:  ${args.denomination} lamports`);
  lines.push("");
  lines.push("This is a PREVIEW (default / --dry-run). It does NOT:");
  lines.push("  - sign anything");
  lines.push("  - send any transaction");
  lines.push("  - write the note secret");
  lines.push("");
  lines.push(
    "With --yes this flow will generate a fresh note secret and then send"
  );
  lines.push(
    "exactly one depositNote transaction via the existing deposit script:"
  );
  lines.push(
    `  ANCHOR_PROVIDER_URL=${cmd.env.ANCHOR_PROVIDER_URL} ANCHOR_WALLET=${cmd.env.ANCHOR_WALLET} \\`
  );
  lines.push(`    ${cmd.bin} ${cmd.argv.join(" ")}`);
  lines.push("");
  lines.push(...noteSecretWarnings());
  lines.push("");
  lines.push(...nextSteps());
  lines.push("");
  lines.push("Re-run with --yes to perform the live devnet deposit.");
  return lines.join("\n");
}

// ── git check-ignore (CLI only) ──────────────────────────────────────────────

function gitChecksIgnore(absPath: string, repoRoot: string): boolean {
  const res = spawnSync("git", ["check-ignore", "-q", "--", absPath], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return res.status === 0;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    process.exit(0);
  }

  const repoRoot = path.resolve(__dirname, "..", "..");

  const args = ((): TesterDepositArgs => {
    try {
      return parseArgs(argv);
    } catch (err) {
      console.error((err as Error).message);
      return process.exit(1);
    }
  })();

  // Validate inputs (all modes): wallet present, devnet RPC, note-output outside repo.
  const walletPath = ((): string => {
    try {
      return resolveWallet(args, process.env);
    } catch (err) {
      console.error((err as Error).message);
      return process.exit(1);
    }
  })();

  try {
    assertDevnetRpc(args.rpc);
    assertNoteOutputOutsideRepo(args.noteOutput, repoRoot, (p) =>
      gitChecksIgnore(p, repoRoot)
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const walletSource = args.wallet !== undefined ? "--wallet" : "ANCHOR_WALLET";

  if (!args.yes) {
    // Preview / dry-run: no signing, no send, no note written.
    console.log(formatDryRun(args, walletSource));
    process.exit(0);
  }

  // ── Live deposit (--yes) ────────────────────────────────────────────────────
  if (!fs.existsSync(walletPath)) {
    console.error(`wallet keypair not found at: ${walletPath}`);
    process.exit(1);
  }

  (async () => {
    console.log(
      "Generating a fresh note secret (the raw secret is never printed)..."
    );
    const result = await (async () => {
      try {
        return await generateAndWriteNote(
          path.resolve(args.noteOutput),
          BigInt(args.denomination)
        );
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    console.log(
      `  note file:      ${path.basename(
        result.secretFile
      )} (saved at your --note-output path; mode 0600; never printed or shared)`
    );
    console.log(`  commitment:     ${result.commitment}`);
    console.log(`  nullifier hash: ${result.nullifierHash}`);
    console.log(`  denomination:   ${args.denomination} lamports`);
    for (const line of noteSecretWarnings()) console.log(line);
    console.log("");
    console.log(
      "Sending exactly one depositNote transaction from your wallet..."
    );

    const cmd = buildDepositCommand({
      rpc: args.rpc,
      walletPath,
      commitmentHex: result.commitment,
      denomination: args.denomination,
    });
    const res = spawnSync(cmd.bin, cmd.argv, {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, ...cmd.env },
    });
    if (res.error) {
      console.error(`deposit failed to start: ${res.error.message}`);
      process.exit(1);
    }
    if (res.status !== 0) {
      console.error(
        `deposit transaction did not complete (exit ${res.status}).`
      );
      process.exit(res.status ?? 1);
    }

    console.log("");
    console.log(
      "Deposit complete. The depositor, transaction signature, and leaf index"
    );
    console.log("are printed above by the deposit step.");
    console.log("");
    for (const line of nextSteps()) console.log(line);
  })();
}
