#!/usr/bin/env ts-node
/**
 * Guided devnet-alpha command planner (prototype).
 *
 * This is a command PLANNER, not a runner. It performs only the safe LOCAL
 * prepare steps and, for every gated / network / heavy step, prints the exact,
 * fully-filled command for the operator to run deliberately. It does not reach
 * `withdraw_zk --simulate` by itself — it helps you get there by producing the
 * correct, ordered command sequence.
 *
 * Safe local steps it may perform:
 *   - verify local ZK artifacts (.zkey, .wasm) against the artifact manifest
 *   - generate a fresh note secret + commitment (secret stays outside the repo)
 *
 * Everything else (deposit, root submission, witness export, proof generation,
 * simulate) is PRINTED as a command, never executed by this planner.
 *
 * Prototype for a future npm UX (e.g. `npx @cirrusprotocol/devnet-alpha plan`).
 *
 * Two phases:
 *   prepare (default): verify artifacts -> generate note -> print the deposit
 *     command and the operator root-submit command -> stop.
 *   resume (--skip-note-generation with --snapshot/--leaf-index/--root): verify
 *     artifacts, then print the ordered command sequence that gets you to
 *     `withdraw_zk --simulate` (check root allowlisted, check nullifier unspent,
 *     export witness, generate the Groth16 proof, compare public inputs, simulate).
 *
 * --dry-run prints the plan and commands and performs no side effects (no secret
 * written, no artifact read, no subprocess, no network).
 *
 * SECURITY / SCOPE:
 *   - No live withdrawal command is ever constructed or run.
 *   - No live root submission is ever constructed or run (the printed submit
 *     command is the read-only dry-run form; submission stays operator-managed).
 *   - No deposit is run; the deposit command is printed for the operator.
 *   - This planner opens no RPC connection itself; printed commands may include
 *     read-only RPC commands, but the planner does not run them.
 *   - No keypairs are read; keypair paths in printed commands are placeholders.
 *   - The note secret is never printed.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import {
  loadManifest,
  verifyArtifact,
  ARTIFACT_SPECS,
  ArtifactResult,
} from "./verify_zk_artifacts";
import {
  parseDenomination,
  assertSafeOutputPath,
  generateAndWriteNote,
} from "./generate_note_secret";

// ── Defaults ────────────────────────────────────────────────────────────────────

export const DEFAULTS = {
  rpc: "https://api.devnet.solana.com",
  programId: "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq",
  denomination: 1_000_000_000n,
  fee: 1_200_000n,
  outputDir: "/tmp/cirrus-devnet-alpha",
  chainId: "1",
  circuitVersion: "1",
} as const;

// ── Args ────────────────────────────────────────────────────────────────────────

export interface PlannerArgs {
  rpc: string;
  programId: string;
  artifactManifest?: string;
  wasm?: string;
  zkey?: string;
  secretOutput?: string;
  recipient?: string;
  relayer?: string;
  denomination: bigint;
  fee: bigint;
  outputDir: string;
  allowUnverifiedWasm: boolean;
  dryRun: boolean;
  // resume
  snapshot?: string;
  leafIndex?: number;
  root?: string;
  skipNoteGeneration: boolean;
}

const ROOT_HEX = /^[0-9a-f]{64}$/;

export function parseArgs(argv: string[]): PlannerArgs {
  const a: PlannerArgs = {
    rpc: DEFAULTS.rpc,
    programId: DEFAULTS.programId,
    denomination: DEFAULTS.denomination,
    fee: DEFAULTS.fee,
    outputDir: DEFAULTS.outputDir,
    allowUnverifiedWasm: false,
    dryRun: false,
    skipNoteGeneration: false,
  };

  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--rpc":
        a.rpc = value(i, flag);
        i++;
        break;
      case "--program-id":
        a.programId = value(i, flag);
        i++;
        break;
      case "--artifact-manifest":
        a.artifactManifest = value(i, flag);
        i++;
        break;
      case "--wasm":
        a.wasm = value(i, flag);
        i++;
        break;
      case "--zkey":
        a.zkey = value(i, flag);
        i++;
        break;
      case "--secret-output":
        a.secretOutput = value(i, flag);
        i++;
        break;
      case "--recipient":
        a.recipient = value(i, flag);
        i++;
        break;
      case "--relayer":
        a.relayer = value(i, flag);
        i++;
        break;
      case "--denomination":
        a.denomination = parseDenomination(value(i, flag));
        i++;
        break;
      case "--fee":
        a.fee = parseDenomination(value(i, flag));
        i++;
        break;
      case "--output-dir":
        a.outputDir = value(i, flag);
        i++;
        break;
      case "--snapshot":
        a.snapshot = value(i, flag);
        i++;
        break;
      case "--leaf-index": {
        const raw = value(i, flag);
        if (!/^[0-9]+$/.test(raw)) {
          throw new Error("--leaf-index must be a non-negative integer");
        }
        a.leafIndex = parseInt(raw, 10);
        i++;
        break;
      }
      case "--root": {
        const raw = value(i, flag).toLowerCase();
        if (!ROOT_HEX.test(raw)) {
          throw new Error("--root must be a 64-char hex string");
        }
        a.root = raw;
        i++;
        break;
      }
      case "--allow-unverified-wasm":
        a.allowUnverifiedWasm = true;
        break;
      case "--skip-note-generation":
        a.skipNoteGeneration = true;
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      default:
        throw new Error(`parseArgs: unknown flag: ${flag}`);
    }
  }

  return a;
}

/** Returns the list of missing required flags for prepare mode. */
export function validatePrepare(args: PlannerArgs): string[] {
  const missing: string[] = [];
  if (!args.artifactManifest) missing.push("--artifact-manifest");
  if (!args.wasm) missing.push("--wasm");
  if (!args.zkey) missing.push("--zkey");
  if (!args.secretOutput) missing.push("--secret-output");
  if (!args.recipient) missing.push("--recipient");
  if (!args.relayer) missing.push("--relayer");
  return missing;
}

/** Returns the list of missing required flags for resume mode. */
export function validateResume(args: PlannerArgs): string[] {
  const missing: string[] = [];
  if (!args.snapshot) missing.push("--snapshot");
  if (args.leafIndex === undefined) missing.push("--leaf-index");
  if (!args.root) missing.push("--root");
  if (!args.secretOutput) missing.push("--secret-output");
  if (!args.recipient) missing.push("--recipient");
  if (!args.relayer) missing.push("--relayer");
  if (!args.wasm) missing.push("--wasm");
  if (!args.zkey) missing.push("--zkey");
  if (!args.artifactManifest) missing.push("--artifact-manifest");
  return missing;
}

// ── Output-path safety ──────────────────────────────────────────────────────────

/**
 * Validates the secret output path: it must be outside the repository, or a
 * git-ignored path inside it. Delegates to the generator's tested guard.
 */
export function validateSecretOutputPath(
  secretOutput: string,
  repoRoot: string,
  isGitIgnored: (absPath: string) => boolean
): void {
  assertSafeOutputPath(secretOutput, repoRoot, isGitIgnored);
}

/** True if a directory is outside the repo or under the OS temp dir. */
export function isSafeOutputDir(dir: string, repoRoot: string): boolean {
  const resolved = path.resolve(dir);
  const rel = path.relative(path.resolve(repoRoot), resolved);
  const insideRepo =
    rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  const underTmp =
    resolved === path.resolve(os.tmpdir()) ||
    resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    resolved.startsWith("/tmp/") ||
    resolved === "/tmp";
  return !insideRepo || underTmp;
}

// ── Artifact gate ────────────────────────────────────────────────────────────────

export interface PlannerArtifactCheck {
  ok: boolean;
  results: ArtifactResult[];
  reasons: string[];
  wasmUnverified: boolean;
}

/**
 * Verifies the proving key (always strict) and the wasm (strict unless
 * allowUnverifiedWasm). The zkey must match a recorded manifest hash; the wasm
 * may be UNVERIFIED only when explicitly allowed, and is reported as such.
 */
export function evaluatePlannerArtifacts(
  manifest: Record<string, unknown>,
  zkeyPath: string,
  wasmPath: string,
  allowUnverifiedWasm: boolean
): PlannerArtifactCheck {
  const results = [
    verifyArtifact(manifest, ARTIFACT_SPECS.zkey, zkeyPath),
    verifyArtifact(manifest, ARTIFACT_SPECS.wasm, wasmPath),
  ];
  const reasons: string[] = [];
  let wasmUnverified = false;

  for (const r of results) {
    if (r.status === "FILE_MISSING") {
      reasons.push(`${r.key}: artifact file missing (${r.filePath})`);
    } else if (r.status === "MISMATCH") {
      reasons.push(`${r.key}: hash mismatch`);
    } else if (r.status === "NO_EXPECTED_HASH") {
      if (r.key === "wasm" && allowUnverifiedWasm) {
        wasmUnverified = true;
      } else {
        reasons.push(
          `${r.key}: no expected hash in manifest — cannot be verified` +
            (r.key === "wasm"
              ? " (pass --allow-unverified-wasm to proceed with an UNVERIFIED wasm)"
              : "")
        );
      }
    }
  }
  return { ok: reasons.length === 0, results, reasons, wasmUnverified };
}

// ── PDA derivation ───────────────────────────────────────────────────────────────

export function derivePdas(programId: string): {
  poolPda: string;
  configPda: string;
} {
  const pid = new PublicKey(programId);
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    pid
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    pid
  );
  return { poolPda: poolPda.toBase58(), configPda: configPda.toBase58() };
}

// ── Output paths ─────────────────────────────────────────────────────────────────

export function outputPaths(args: PlannerArgs): {
  witness: string;
  publicWitness: string;
  circuitInput: string;
  proof: string;
  publicSnarkjs: string;
} {
  const od = args.outputDir;
  return {
    witness: path.join(od, "witness.json"),
    publicWitness: path.join(od, "public.json"),
    circuitInput: path.join(od, "circuit_input.json"),
    proof: path.join(od, "proof.json"),
    publicSnarkjs: path.join(od, "public_snarkjs.json"),
  };
}

// ── Caveats & plan ──────────────────────────────────────────────────────────────

export function caveats(): string[] {
  return [
    "Cirrus devnet-alpha command planner (prototype) — simulate-only target.",
    "  - Devnet only. Not mainnet. No real funds.",
    "  - Unaudited. Single-operator deployment.",
    "  - No privacy guarantee: recipient, relayer, and amount are plaintext on-chain.",
    "  - Root submission is operator-managed; this planner never submits roots.",
    "  - This planner prints commands; it does not run a live withdrawal or deposit.",
  ];
}

export function planSteps(): string[] {
  return [
    "1. Verify local ZK artifacts (.zkey, .wasm) against the artifact manifest.",
    "2. Generate a fresh note secret + commitment (secret stays outside the repo; never printed).",
    "3. STOP and print the exact deposit command for you to run (deposit is a devnet mutation).",
    "4. Print the operator root-submission command (operator-managed; not run here).",
    "5. After deposit + root submission, re-run in resume mode. The planner then prints the",
    "   ordered commands to reach withdraw_zk --simulate (confirm root allowlisted, confirm",
    "   nullifier unspent, export witness, generate the Groth16 proof, compare public inputs,",
    "   simulate). You run those commands; the planner does not run them.",
  ];
}

// ── Help text ─────────────────────────────────────────────────────────────────

/**
 * Usage text for --help / -h. Examples use angle-bracket placeholders only;
 * they contain no concrete wallet paths and construct no live send.
 */
export function helpText(): string {
  return [
    "devnet_alpha_plan.ts — guided Cirrus devnet-alpha command planner — not a runner.",
    "",
    "Devnet alpha only. Unaudited. Not for real funds. No privacy guarantee.",
    "Target is simulate-only: there is no live withdraw step and no live send.",
    "This planner prints commands only — it runs no live withdrawal and performs",
    "only safe local prepare behavior (verify local artifacts, generate a note",
    "secret outside the repo). Deposit, root submission, witness export, proof",
    "generation, and simulate are PRINTED for you to run deliberately. Root",
    "submission is operator-managed.",
    "",
    "Modes:",
    "  prepare (default)                Verify artifacts, generate a note, and print",
    "                                   the deposit and operator root-submit commands.",
    "  resume (--skip-note-generation)  Print the ordered commands that reach",
    "                                   withdraw_zk --simulate (the simulate-only target).",
    "",
    "Prepare required flags:",
    "  --artifact-manifest <path>       Manifest with recorded artifact hashes.",
    "  --wasm <path>                    Circuit .wasm path.",
    "  --zkey <path>                    Proving key .zkey path.",
    "  --secret-output <outside-repo-path>   Where the note secret is written (0600).",
    "  --recipient <pubkey>",
    "  --relayer <pubkey>",
    "",
    "Resume required flags:",
    "  --skip-note-generation",
    "  --snapshot <path>",
    "  --leaf-index <n>",
    "  --root <64-hex-root>",
    "  --secret-output <outside-repo-path>",
    "  --recipient <pubkey>",
    "  --relayer <pubkey>",
    "  --artifact-manifest <path>",
    "  --wasm <path>",
    "  --zkey <path>",
    "",
    "Optional flags:",
    "  --rpc <url>                      RPC endpoint (default: devnet).",
    "  --program-id <pubkey>",
    "  --denomination <lamports>",
    "  --fee <lamports>",
    "  --output-dir <outside-repo-or-temp-path>",
    "  --allow-unverified-wasm",
    "  --dry-run                        Print the plan only: no secret written, no",
    "                                   artifact read, no subprocess, no network.",
    "  --help, -h                       Print this help and exit.",
    "",
    "Examples:",
    "  # Prepare (dry-run: plan only, nothing generated or run):",
    "  npx ts-node --project tsconfig.json scripts/ops/devnet_alpha_plan.ts \\",
    "    --artifact-manifest <manifest> --wasm <wasm-path> --zkey <zkey-path> \\",
    "    --secret-output <outside-repo-path> --recipient <recipient> \\",
    "    --relayer <relayer> --dry-run",
    "",
    "  # Resume (after deposit + operator root submit) to print the simulate sequence:",
    "  npx ts-node --project tsconfig.json scripts/ops/devnet_alpha_plan.ts \\",
    "    --skip-note-generation --snapshot <snapshot> --leaf-index <n> \\",
    "    --root <64-hex-root> --secret-output <outside-repo-path> \\",
    "    --recipient <recipient> --relayer <relayer> \\",
    "    --artifact-manifest <manifest> --wasm <wasm-path> --zkey <zkey-path>",
  ].join("\n");
}

// ── Command builders (printed instructions only; never executed by this planner) ─

const NPX = "npx ts-node --project tsconfig.json";

/** Operator runs this. Printed instruction only — never executed by the planner. */
export function buildDepositCommand(
  args: PlannerArgs,
  commitment: string
): string {
  return (
    `ANCHOR_PROVIDER_URL=${args.rpc} ANCHOR_WALLET=<your-depositor-keypair.json> \\\n` +
    `  ${NPX} scripts/ops/deposit_note_devnet.ts \\\n` +
    `    --commitment ${commitment} --denomination ${args.denomination} --yes`
  );
}

/**
 * Operator-managed root submission. Deliberately the read-only dry-run form:
 * this planner never constructs a live root submission.
 */
export function buildSubmitRootCommand(args: PlannerArgs): string {
  return (
    `ANCHOR_PROVIDER_URL=${args.rpc} ANCHOR_WALLET=<root-submitter-keypair.json> \\\n` +
    `  ${NPX} scripts/ops/submit_root_devnet.ts \\\n` +
    `    --snapshot <your-snapshot.json> --program-id ${args.programId} \\\n` +
    `    --expected-root <root-from-snapshot> --commitment confirmed --dry-run`
  );
}

export function buildInspectRootCommand(args: PlannerArgs): string {
  return (
    `${NPX} scripts/ops/inspect_allowed_roots_devnet.ts \\\n` +
    `    --rpc-url ${args.rpc} --program-id ${args.programId} \\\n` +
    `    --expected-root ${args.root ?? "<root>"}`
  );
}

export function buildInspectNullifierCommand(args: PlannerArgs): string {
  return (
    `${NPX} scripts/ops/inspect_nullifier_state_devnet.ts \\\n` +
    `    --rpc-url ${args.rpc} --program-id ${args.programId} \\\n` +
    `    --nullifier-hash <NULLIFIER_HASH printed during the prepare step>`
  );
}

export function buildWitnessExportCommand(args: PlannerArgs): string {
  const { poolPda, configPda } = derivePdas(args.programId);
  const out = outputPaths(args);
  return (
    `CUR_SLOT=$(solana slot --url ${args.rpc}); EXPIRY_SLOT=$((CUR_SLOT + 100000))\n` +
    `${NPX} scripts/zk_prover_export_witness.ts \\\n` +
    `    --snapshot ${args.snapshot ?? "<snapshot.json>"} \\\n` +
    `    --leaf-index ${args.leafIndex ?? "<leaf-index>"} \\\n` +
    `    --secret-file ${
      args.secretOutput ?? "<your --secret-output path>"
    } \\\n` +
    `    --denomination ${args.denomination} --fee ${args.fee} \\\n` +
    `    --chain-id ${DEFAULTS.chainId} --expiry-slot $EXPIRY_SLOT \\\n` +
    `    --program-id ${args.programId} --pool-pda ${poolPda} --config-pda ${configPda} \\\n` +
    `    --recipient ${args.recipient ?? "<recipient>"} --relayer ${
      args.relayer ?? "<relayer>"
    } \\\n` +
    `    --witness-output ${out.witness} --public-output ${out.publicWitness} \\\n` +
    `    --circuit-input-output ${out.circuitInput} --yes`
  );
}

export function buildSnarkjsCommand(args: PlannerArgs): string {
  const out = outputPaths(args);
  return (
    `cd ${args.outputDir} && npx --yes snarkjs@0.7.4 groth16 fullprove \\\n` +
    `    ${out.circuitInput} \\\n` +
    `    ${args.wasm ?? "<wasm>"} \\\n` +
    `    ${args.zkey ?? "<zkey>"} \\\n` +
    `    ${out.proof} ${out.publicSnarkjs}`
  );
}

export function buildSimulateCommand(args: PlannerArgs): string {
  const out = outputPaths(args);
  return (
    `${NPX} scripts/ops/withdraw_zk_devnet.ts \\\n` +
    `    --simulate --rpc ${args.rpc} --program-id ${args.programId} \\\n` +
    `    --relayer ${args.relayer ?? "<relayer>"} --recipient ${
      args.recipient ?? "<recipient>"
    } \\\n` +
    `    --proof-json ${out.proof} --public-json ${out.publicSnarkjs} \\\n` +
    `    --input-json ${out.circuitInput} \\\n` +
    `    --denomination ${args.denomination} --fee ${args.fee} \\\n` +
    `    --expiry-slot $EXPIRY_SLOT --circuit-version ${DEFAULTS.circuitVersion} \\\n` +
    `    --expected-root ${args.root ?? "<root>"}`
  );
}

// ── git check-ignore (CLI only) ──────────────────────────────────────────────────

function gitChecksIgnore(absPath: string, repoRoot: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require("child_process");
  const res = spawnSync("git", ["check-ignore", "-q", "--", absPath], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return res.status === 0;
}

// ── CLI entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const repoRoot = path.resolve(__dirname, "..", "..");

  // --help / -h is handled before required-flag validation so it never requires
  // any other flag and always exits cleanly.
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    process.exit(0);
  }

  const args = (() => {
    try {
      return parseArgs(argv);
    } catch (err) {
      console.error((err as Error).message);
      return process.exit(1);
    }
  })();

  const line = (s = "") => console.log(s);
  const section = (title: string) => {
    line("");
    line(`── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
  };

  const resumeCommandHint = (a: PlannerArgs): string =>
    `${NPX} scripts/ops/devnet_alpha_plan.ts --skip-note-generation \\\n` +
    `    --snapshot <snapshot.json> --leaf-index <n> --root <root> \\\n` +
    `    --secret-output ${a.secretOutput} --recipient ${a.recipient} \\\n` +
    `    --relayer ${a.relayer} --wasm ${a.wasm} --zkey ${a.zkey} \\\n` +
    `    --artifact-manifest ${a.artifactManifest}`;

  section("Caveats");
  for (const c of caveats()) line(c);

  // Output-dir safety (applies in all modes).
  if (!isSafeOutputDir(args.outputDir, repoRoot)) {
    console.error(
      `\n--output-dir must be outside the repository or under the temp dir: ${args.outputDir}`
    );
    process.exit(1);
  }

  if (args.skipNoteGeneration) {
    // ── Resume mode: validate, verify artifacts, then print the command sequence ─
    const missing = validateResume(args);
    if (missing.length > 0) {
      console.error(
        `\nresume mode is missing required flags: ${missing.join(", ")}`
      );
      process.exit(1);
    }

    section("Artifact verification");
    const manifest = (() => {
      try {
        return loadManifest(args.artifactManifest as string);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();
    const check = evaluatePlannerArtifacts(
      manifest,
      args.zkey as string,
      args.wasm as string,
      args.allowUnverifiedWasm
    );
    for (const r of check.results) {
      line(`  ${r.key}: ${r.status}${r.field ? ` (field ${r.field})` : ""}`);
    }
    if (check.wasmUnverified) {
      line(
        "  WARNING: wasm is UNVERIFIED (no hash in manifest; allowed via --allow-unverified-wasm)."
      );
    }
    if (!check.ok) {
      console.error(
        "\nArtifact verification failed; not printing proof/simulate commands:"
      );
      for (const reason of check.reasons) console.error(`  - ${reason}`);
      process.exit(1);
    }

    section("Resume plan (guided commands — review and run each deliberately)");
    line("1. Confirm the root is present in allowed_roots:");
    line(buildInspectRootCommand(args));
    line("");
    line("2. Confirm the nullifier is still unspent:");
    line(buildInspectNullifierCommand(args));
    line("");
    line("   If the root is NOT present, ask the operator to submit it first:");
    line(buildSubmitRootCommand(args));
    line("");
    line("3. Export the witness (writes artifacts under the output dir):");
    line(buildWitnessExportCommand(args));
    line("");
    line("4. Generate the Groth16 proof with pinned snarkjs:");
    line(buildSnarkjsCommand(args));
    line("");
    line("5. Compare public inputs, then run the read-only simulate:");
    line(buildSimulateCommand(args));
    line("");
    line("This planner stops here. It does not run a live withdrawal.");
    process.exit(0);
  }

  // ── Prepare mode ──────────────────────────────────────────────────────────────
  const missing = validatePrepare(args);
  if (missing.length > 0) {
    console.error(
      `\nprepare mode is missing required flags: ${missing.join(", ")}`
    );
    process.exit(1);
  }

  if (args.dryRun) {
    section(
      "Planned steps (--dry-run: nothing is verified, generated, or run)"
    );
    for (const s of planSteps()) line(s);
    section("Deposit command (you run this after a real prepare run)");
    line(buildDepositCommand(args, "<COMMITMENT generated in a real run>"));
    section("Operator root submission (operator-managed; dry-run form)");
    line(buildSubmitRootCommand(args));
    section("Resume command (after deposit + root submission)");
    line(resumeCommandHint(args));
    line("");
    line(
      "[DRY RUN] No artifacts verified. No secret generated. No file written."
    );
    process.exit(0);
  }

  // Real prepare run: verify artifacts, then generate the note secret locally.
  (async () => {
    // Output-path safety for the secret file.
    try {
      validateSecretOutputPath(args.secretOutput as string, repoRoot, (p) =>
        gitChecksIgnore(p, repoRoot)
      );
    } catch (err) {
      console.error(`\n${(err as Error).message}`);
      process.exit(1);
    }

    section("Artifact verification");
    const manifest = (() => {
      try {
        return loadManifest(args.artifactManifest as string);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();
    const check = evaluatePlannerArtifacts(
      manifest,
      args.zkey as string,
      args.wasm as string,
      args.allowUnverifiedWasm
    );
    for (const r of check.results) {
      line(`  ${r.key}: ${r.status}${r.field ? ` (field ${r.field})` : ""}`);
    }
    if (check.wasmUnverified) {
      line(
        "  WARNING: wasm is UNVERIFIED (no hash in manifest; allowed via --allow-unverified-wasm)."
      );
    }
    if (!check.ok) {
      console.error("\nArtifact verification failed:");
      for (const reason of check.reasons) console.error(`  - ${reason}`);
      process.exit(1);
    }

    section("Note generation");
    const result = await (async () => {
      try {
        return await generateAndWriteNote(
          path.resolve(args.secretOutput as string),
          args.denomination
        );
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();
    line(
      `  secret file: ${result.secretFile} (mode 0600; never share or commit)`
    );
    line(`  commitment:  ${result.commitment}`);
    line(`  nullifier:   ${result.nullifierHash}`);

    section("Next: deposit this commitment (devnet mutation — you run it)");
    line(buildDepositCommand(args, result.commitment));

    section("Then: operator submits the resulting root (operator-managed)");
    line(buildSubmitRootCommand(args));

    section("Then: resume to get the simulate command sequence");
    line(resumeCommandHint(args));
    line("");
    line(
      "This planner stops here. It does not deposit, submit roots, or run a live withdrawal."
    );
  })();
}
