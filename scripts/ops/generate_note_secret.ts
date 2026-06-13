#!/usr/bin/env ts-node
/**
 * Operator helper that generates a fresh note secret and its deposit commitment.
 *
 * Generates a canonical, non-zero BN254 Fr note secret with
 * crypto.randomBytes + rejection sampling, writes the 64-char lowercase hex
 * secret to an operator-chosen out-of-repo file with mode 0600, derives the
 * deposit commitment and nullifier hash using the repo's existing Poseidon
 * helpers, and prints ONLY the public values needed for the deposit / witness
 * flow.
 *
 * SECURITY:
 *   - The raw secret is NEVER printed, logged, or returned to callers. It is
 *     written only to the --secret-output file with restrictive permissions.
 *   - The commitment and nullifier hash are public. The secret is not.
 *   - Public values are derived BEFORE the secret file is written, so a hash
 *     failure never leaves a secret file behind.
 *   - This script opens no RPC connection, sends no transaction, and generates
 *     no keypair. It performs no on-chain action.
 *
 * Modes (exactly one of --dry-run / --yes is required):
 *   --dry-run   Validates the output path and denomination and reports the
 *               intended action. Generates NO secret and writes NO file.
 *               Prints no commitment/nullifier because no secret exists.
 *   --yes       Generates the secret, writes it to --secret-output (mode 0600),
 *               derives and prints the commitment and nullifier hash.
 *
 * Flags:
 *   --secret-output <path>     Required. Destination for the secret hex file.
 *                              Must be outside the repository, or a git-ignored
 *                              path inside it. Refuses to overwrite an existing
 *                              file.
 *   --denomination <lamports>  Required. Positive decimal integer (<= u64 max).
 *   --json                     Emit machine-readable JSON instead of human text.
 *                              The secret is excluded from JSON as well.
 *
 * The secret file is required later for witness export. Keep it; never share it;
 * never commit it. Anyone holding the secret can spend the note.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  computeNoteCommitment,
  computeNullifierHash,
} from "../../lib/zk_prover/witness";
import { initPoseidon } from "../../lib/zk_indexer/poseidon";
import { BN254_FR_MODULUS_HEX } from "../../lib/zk_indexer/constants";

// ── Constants ─────────────────────────────────────────────────────────────────

export const BN254_FR_MODULUS = BigInt("0x" + BN254_FR_MODULUS_HEX);
export const U64_MAX = 18446744073709551615n;

// ── Denomination parsing ──────────────────────────────────────────────────────

/**
 * Parses a positive denomination (lamports) from a decimal string.
 * Rejects zero, negatives, leading zeros, fractional, hex notation, and any
 * value greater than the u64 maximum. Returns the value as a bigint.
 */
export function parseDenomination(s: string): bigint {
  if (!/^[1-9][0-9]*$/.test(s)) {
    throw new Error(
      `--denomination must be a positive decimal integer ` +
        `(no leading zeros, no sign, no hex, no fraction); got: ${JSON.stringify(
          s
        )}`
    );
  }
  const n = BigInt(s);
  if (n > U64_MAX) {
    throw new Error(
      `--denomination exceeds u64 maximum (${U64_MAX}); got: ${s}`
    );
  }
  return n;
}

// ── Secret generation ─────────────────────────────────────────────────────────

/**
 * Generates a canonical, non-zero BN254 Fr element via rejection sampling.
 * Draws 32 random bytes and retries until the value is in [1, p-1].
 *
 * SECURITY: the returned value is the raw note secret. Never log or print it.
 */
export function generateCanonicalSecret(
  randomBytes: (size: number) => Buffer = crypto.randomBytes
): bigint {
  for (;;) {
    const n = BigInt("0x" + randomBytes(32).toString("hex"));
    if (n !== 0n && n < BN254_FR_MODULUS) return n;
  }
}

/** Serializes a BN254 Fr secret to a 64-char lowercase hex string (32-byte BE). */
export function secretToHex(secret: bigint): string {
  if (secret <= 0n || secret >= BN254_FR_MODULUS) {
    throw new Error(
      "secretToHex: value is not a canonical non-zero Fr element"
    );
  }
  return secret.toString(16).padStart(64, "0");
}

// ── Output-path safety ────────────────────────────────────────────────────────

/**
 * Returns true if `outputPath` resolves to a location inside `repoRoot`.
 * Pure path math — does not touch the filesystem or git.
 */
export function isPathInsideRepo(
  outputPath: string,
  repoRoot: string
): boolean {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(outputPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Asserts that the secret output path is safe to write to:
 *   - a path outside the repository is always allowed, or
 *   - a path inside the repository is allowed only if git ignores it.
 *
 * `isGitIgnored` is injected so this guard is testable without invoking git.
 * Throws a descriptive error when an in-repo, non-ignored path is given.
 */
export function assertSafeOutputPath(
  outputPath: string,
  repoRoot: string,
  isGitIgnored: (absPath: string) => boolean
): void {
  const resolved = path.resolve(outputPath);
  if (isPathInsideRepo(resolved, repoRoot)) {
    if (!isGitIgnored(resolved)) {
      throw new Error(
        `--secret-output path is inside the repository and not git-ignored:\n` +
          `  ${resolved}\n` +
          `Choose a path outside the repository (recommended), or a path that\n` +
          `is covered by .gitignore. The note secret must never be committed.`
      );
    }
  }
}

// ── Argument parsing ──────────────────────────────────────────────────────────

export interface GenerateNoteSecretArgs {
  dryRun: boolean;
  yes: boolean;
  secretOutput: string;
  denomination: bigint;
  json: boolean;
}

export function parseArgs(argv: string[]): GenerateNoteSecretArgs {
  let dryRun = false;
  let yes = false;
  let json = false;
  let secretOutput: string | undefined;
  let denominationStr: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      dryRun = true;
    } else if (flag === "--yes") {
      yes = true;
    } else if (flag === "--json") {
      json = true;
    } else if (flag === "--secret-output") {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error("--secret-output requires a file path");
      }
      secretOutput = val;
      i++;
    } else if (flag === "--denomination") {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error("--denomination requires a positive decimal integer");
      }
      denominationStr = val;
      i++;
    } else {
      throw new Error(`parseArgs: unknown flag: ${flag}`);
    }
  }

  if (dryRun === yes) {
    throw new Error(
      "exactly one of --dry-run or --yes is required (got " +
        (dryRun ? "both" : "neither") +
        ")"
    );
  }
  if (secretOutput === undefined) {
    throw new Error("--secret-output is required");
  }
  if (denominationStr === undefined) {
    throw new Error("--denomination is required");
  }

  return {
    dryRun,
    yes,
    secretOutput,
    denomination: parseDenomination(denominationStr),
    json,
  };
}

// ── Generation + rendering ─────────────────────────────────────────────────────

export interface GenerateResult {
  secretFile: string;
  denomination: string;
  commitment: string;
  nullifierHash: string;
}

/**
 * Generates a secret, derives the deposit commitment and nullifier hash, then
 * writes the secret to `resolvedOutput` with mode 0600. Refuses to overwrite an
 * existing file. Requires the output directory to already exist.
 *
 * Ordering is deliberate: the public values are derived BEFORE the secret file
 * is written, so a Poseidon/hash failure never leaves a secret file behind.
 * The write uses an exclusive-create flag ("wx") so a concurrent create cannot
 * be clobbered (TOCTOU-safe), with chmod 0600 as a defensive follow-up.
 *
 * SECURITY: the returned GenerateResult intentionally omits the secret. The raw
 * secret exists only inside this function and in the on-disk file.
 */
export async function generateAndWriteNote(
  resolvedOutput: string,
  denomination: bigint,
  randomBytes: (size: number) => Buffer = crypto.randomBytes
): Promise<GenerateResult> {
  if (fs.existsSync(resolvedOutput)) {
    throw new Error(`Refusing to overwrite existing file: ${resolvedOutput}`);
  }

  const secret = generateCanonicalSecret(randomBytes);
  const secretHex = secretToHex(secret);

  // Derive the public values first. If hashing throws, no file has been written.
  await initPoseidon();
  const commitment = computeNoteCommitment(secret, denomination);
  const nullifierHash = computeNullifierHash(secret);

  // Atomic exclusive create — fails with EEXIST if the file already exists.
  fs.writeFileSync(resolvedOutput, secretHex, { mode: 0o600, flag: "wx" });
  fs.chmodSync(resolvedOutput, 0o600);

  return {
    secretFile: resolvedOutput,
    denomination: denomination.toString(),
    commitment,
    nullifierHash,
  };
}

/** Deposit command template that uses the public commitment (no secret). */
export function depositCommandTemplate(result: GenerateResult): string {
  return (
    `npx ts-node scripts/ops/deposit_note_devnet.ts ` +
    `--commitment ${result.commitment} ` +
    `--denomination ${result.denomination} --yes`
  );
}

/** Renders the public human-readable output. Never includes the secret. */
export function renderHuman(result: GenerateResult): string {
  return [
    `Secret file:      ${result.secretFile}`,
    `                  (mode 0600 — keep outside the repo; never commit or share)`,
    `Denomination:     ${result.denomination} lamports`,
    `Commitment:       ${result.commitment}`,
    `Nullifier hash:   ${result.nullifierHash}`,
    ``,
    `Deposit this commitment (requires explicit approval):`,
    `  ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \\`,
    `  ANCHOR_WALLET=<depositor-keypair.json> \\`,
    `  ${depositCommandTemplate(result)}`,
    ``,
    `WARNING: The note secret is required later for witness export.`,
    `         It is never printed; it lives only in the file above.`,
    `         Anyone holding the secret can spend this note. Do not share it.`,
  ].join("\n");
}

/** Renders the public JSON output. Never includes the secret. */
export function renderJson(result: GenerateResult): string {
  return JSON.stringify(
    {
      secret_file: result.secretFile,
      denomination: result.denomination,
      commitment: result.commitment,
      nullifier_hash: result.nullifierHash,
      deposit_note_command: depositCommandTemplate(result),
      warning:
        "secret is required later for witness export; it is never printed and " +
        "must never be shared or committed",
    },
    null,
    2
  );
}

/** Renders the --dry-run report. No secret is generated; no file is written. */
export function renderDryRun(
  resolvedOutput: string,
  denomination: bigint
): string {
  return [
    `[DRY RUN] No secret generated. No file written.`,
    `Intended secret file: ${resolvedOutput}`,
    `Denomination:         ${denomination.toString()} lamports`,
    `Safety checks passed:`,
    `  - output path is outside the repository (or git-ignored)`,
    `  - output file does not already exist`,
    ``,
    `No commitment or nullifier is shown in dry-run because no secret exists yet.`,
    `Re-run with --yes to generate the secret and derive the commitment.`,
  ].join("\n");
}

// ── git check-ignore (CLI only) ────────────────────────────────────────────────

/**
 * Returns true if git reports `absPath` as ignored. Runs git with cwd set to
 * `repoRoot` so the check is evaluated against this repository, not the caller's
 * current directory. Returns false on any error (including "not a git
 * repository"), so in-repo paths fail closed.
 */
function gitChecksIgnore(absPath: string, repoRoot: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require("child_process");
  const res = spawnSync("git", ["check-ignore", "-q", "--", absPath], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return res.status === 0;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);

    const args = (() => {
      try {
        return parseArgs(argv);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    const repoRoot = path.resolve(__dirname, "..", "..");
    const resolvedOutput = path.resolve(args.secretOutput);

    // git check-ignore is evaluated against this repo regardless of cwd.
    const isGitIgnored = (absPath: string): boolean =>
      gitChecksIgnore(absPath, repoRoot);

    // Path safety: never allow an in-repo, non-ignored secret destination.
    try {
      assertSafeOutputPath(resolvedOutput, repoRoot, isGitIgnored);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    // Refuse to overwrite in both modes (fail closed).
    if (fs.existsSync(resolvedOutput)) {
      console.error(`Refusing to overwrite existing file: ${resolvedOutput}`);
      process.exit(1);
    }

    if (args.dryRun) {
      console.log(renderDryRun(resolvedOutput, args.denomination));
      return;
    }

    // ── Confirmed generation path ──────────────────────────────────────────────
    const result = await (async () => {
      try {
        return await generateAndWriteNote(resolvedOutput, args.denomination);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    console.log(args.json ? renderJson(result) : renderHuman(result));
  })();
}
