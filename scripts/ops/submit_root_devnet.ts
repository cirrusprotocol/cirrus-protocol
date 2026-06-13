#!/usr/bin/env ts-node
/**
 * Guarded operator script to submit a verified Merkle root to the on-chain
 * allowed_roots registry via addAllowedRoot.
 *
 * Reads a local indexer snapshot produced by scripts/zk_indexer_rpc_fetch.ts,
 * validates it fully (structural checks + full tree replay), and optionally
 * submits the contained root via one addAllowedRoot transaction.
 *
 * Required environment variables (--yes path only):
 *   ANCHOR_PROVIDER_URL  — cluster RPC endpoint (must not be mainnet)
 *   ANCHOR_WALLET        — path to root_submitter keypair (must be root_submitter_authority)
 *
 * Modes:
 *   --dry-run   Validate snapshot and print root preview.  No RPC connection
 *               opened; no transaction sent; no wallet needed.
 *   --yes       Open RPC, run read-only preflight checks, submit exactly one
 *               addAllowedRoot transaction.  Requires explicit approval.
 *   (neither)   Print intent and exit without sending.  No RPC connection.
 *               No env vars needed.
 *
 * --dry-run and --yes are mutually exclusive.
 *
 * Does not call deposit_note.  Does not call withdraw_zk.
 * Does not generate keypairs.  Does not request airdrops.
 * Root submission is not ZK proof verification.  It only registers a root in
 * the on-chain allowed_roots list.  Until withdraw_zk (Phase 4) is
 * implemented, root submission does not create privacy or trustless
 * withdrawals.
 */

import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { initPoseidon } from "../../lib/zk_indexer/poseidon";
import { loadSnapshot } from "../../lib/zk_indexer/persistence";
import type {
  PersistedIndexerSnapshot,
  SnapshotFetchMeta,
} from "../../lib/zk_indexer/persistence";
import { TREE_DEPTH } from "../../lib/zk_indexer/constants";

// ── Constants ──────────────────────────────────────────────────────────────────

export const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";

// Must match MAX_ROOTS in programs/shielded_pool_anchor/src/state.rs.
export const MAX_ROOTS = 10;

const ALL_ZERO_ROOT = "0".repeat(64);

// ── Program ID validation ──────────────────────────────────────────────────────

/**
 * Validates the IDL address field against PROGRAM_ID. Returns the validated
 * PublicKey. Throws if the address is missing, invalid, or mismatched.
 */
export function validateIdlAddress(idl: { address?: string }): PublicKey {
  if (!idl.address) {
    throw new Error("IDL is missing address field");
  }
  const address = idl.address;
  const pk = (() => {
    try {
      return new PublicKey(address);
    } catch {
      throw new Error(`IDL address is not a valid public key: ${address}`);
    }
  })();
  if (pk.toBase58() !== PROGRAM_ID) {
    throw new Error(
      `IDL program ID mismatch:\n` +
        `  IDL:      ${pk.toBase58()}\n` +
        `  Expected: ${PROGRAM_ID}\n` +
        `Verify you are using the IDL for the correct deployment.`
    );
  }
  return pk;
}

// ── Interfaces ─────────────────────────────────────────────────────────────────

export interface SubmitRootArgs {
  snapshotPath: string;
  programId: string;
  commitment: "confirmed" | "finalized" | "processed";
  expectedRoot?: string;
  allowExisting: boolean;
  dryRun: boolean;
  yes: boolean;
}

export interface VerifierConfigData {
  adminAuthority: PublicKey;
  rootSubmitterAuthority: PublicKey;
  paused: boolean;
  allowedRoots: Array<number[]>;
}

export interface SubmitRootDeps {
  rootSubmitterPubkey: PublicKey;
  fetchConfig: (configPda: PublicKey) => Promise<VerifierConfigData | null>;
  sendAddAllowedRoot: (root: number[]) => Promise<string>;
  refetchConfig: (configPda: PublicKey) => Promise<VerifierConfigData | null>;
}

export interface SubmitRootResult {
  snapshotPath: string;
  snapshotVersion: number;
  snapshotMeta?: SnapshotFetchMeta;
  leafCount: number;
  eventCount: number;
  root: string;
  dryRun: boolean;
  sent: boolean;
  txSignature?: string;
  postSendVerified: boolean;
}

// ── PDA derivation ─────────────────────────────────────────────────────────────

export function deriveConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    programId
  );
}

// ── Validation helpers ─────────────────────────────────────────────────────────

/**
 * Validates that hex is a 64-char hex string representing a non-zero 32-byte
 * value.  Throws a descriptive error on any violation.
 */
export function validateRootHex(hex: string, label = "root"): void {
  if (typeof hex !== "string") {
    throw new Error(`${label}: expected string, got ${typeof hex}`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `${label}: must be exactly 64 hex characters; got ${JSON.stringify(hex)}`
    );
  }
  if (hex.toLowerCase() === ALL_ZERO_ROOT) {
    throw new Error(`${label}: must not be the all-zero root`);
  }
}

/**
 * Reads and performs basic structural validation of a snapshot JSON file.
 * Does NOT call initPoseidon() or perform tree replay.
 * Full cryptographic verification (tree replay, root consistency) is done
 * by loadSnapshot() inside runSubmitRoot.
 *
 * Throws on:
 *   - unreadable file
 *   - invalid JSON
 *   - version !== 1
 *   - tree_depth !== TREE_DEPTH
 *   - events missing or empty
 *   - leaf_count missing, zero, or negative
 *   - last_root_be_hex missing, malformed, or all-zero
 */
export function parseSnapshotFile(filePath: string): PersistedIndexerSnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `parseSnapshotFile: cannot read snapshot at ${filePath}: ${
        (err as Error).message
      }`
    );
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `parseSnapshotFile: invalid JSON in ${filePath}: ${
        (err as Error).message
      }`
    );
  }

  const snap = obj as Record<string, unknown>;

  if (snap.version !== 1 && snap.version !== 2) {
    throw new Error(
      `parseSnapshotFile: unsupported version ${snap.version}, expected 1 or 2`
    );
  }
  if (snap.tree_depth !== TREE_DEPTH) {
    throw new Error(
      `parseSnapshotFile: tree_depth mismatch: expected ${TREE_DEPTH}, got ${snap.tree_depth}`
    );
  }
  if (!Array.isArray(snap.events) || snap.events.length === 0) {
    throw new Error(
      `parseSnapshotFile: events must be a non-empty array; got ` +
        `${Array.isArray(snap.events) ? "empty array" : typeof snap.events}`
    );
  }
  if (typeof snap.leaf_count !== "number" || snap.leaf_count <= 0) {
    throw new Error(
      `parseSnapshotFile: leaf_count must be a positive integer; got ${snap.leaf_count}`
    );
  }
  if (typeof snap.last_root_be_hex !== "string") {
    throw new Error(
      `parseSnapshotFile: last_root_be_hex must be a string; got ${typeof snap.last_root_be_hex}`
    );
  }

  validateRootHex(snap.last_root_be_hex, "last_root_be_hex");

  return obj as PersistedIndexerSnapshot;
}

// ── Core runner ────────────────────────────────────────────────────────────────

function rootBytesMatch(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Validates the snapshot and optionally submits its root to allowed_roots.
 *
 * deps is required only in --yes mode.  Dry-run and neither-mode require no
 * network access.
 *
 * Steps:
 *   1. parseSnapshotFile — basic structural validation (no Poseidon).
 *   2. expected-root guard — compare args.expectedRoot vs snapshot root.
 *   3. initPoseidon + loadSnapshot — full tree-replay verification.
 *   4. [dry-run returns here]
 *   5. [neither-mode (yes=false) throws clear error here — no send ever happens]
 *   6. Derive configPda; fetchConfig via deps.
 *   7. Preflight: admin_authority, paused, root presence, capacity.
 *   8. sendAddAllowedRoot — exactly one transaction.
 *   9. refetchConfig — confirm root is now present.
 */
export async function runSubmitRoot(
  args: SubmitRootArgs,
  deps?: SubmitRootDeps
): Promise<SubmitRootResult> {
  // Step 1: Fast structural validation — no Poseidon, no RPC.
  const rawSnap = parseSnapshotFile(args.snapshotPath);

  // Step 2: Expected-root guard before the (heavier) tree replay.
  if (args.expectedRoot !== undefined) {
    if (
      args.expectedRoot.toLowerCase() !== rawSnap.last_root_be_hex.toLowerCase()
    ) {
      throw new Error(
        `expected-root mismatch:\n` +
          `  arg:      ${args.expectedRoot}\n` +
          `  snapshot: ${rawSnap.last_root_be_hex}`
      );
    }
  }

  // Step 3: Full verification — Poseidon tree replay + root/leaf_count checks.
  await initPoseidon();
  const { snapshot } = loadSnapshot(args.snapshotPath);

  const result: SubmitRootResult = {
    snapshotPath: args.snapshotPath,
    snapshotVersion: snapshot.version,
    snapshotMeta: snapshot.meta,
    leafCount: snapshot.leaf_count,
    eventCount: snapshot.events.length,
    root: snapshot.last_root_be_hex,
    dryRun: args.dryRun,
    sent: false,
    postSendVerified: false,
  };

  if (snapshot.meta?.fetch_commitment === "processed") {
    console.warn(
      `[WARN] Snapshot was fetched at 'processed' commitment level ` +
        `(meta.fetch_commitment=processed). Processed roots may reflect ` +
        `fork-candidates that have not been voted on by the cluster. Use ` +
        `confirmed for the devnet alpha and finalized before any production ` +
        `root registration. See docs/indexer_finality_policy.md.`
    );
  }

  if (
    snapshot.meta?.program_id !== undefined &&
    snapshot.meta.program_id.toLowerCase() !== args.programId.toLowerCase()
  ) {
    console.warn(
      `[WARN] Snapshot meta.program_id does not match --program-id:\n` +
        `  snapshot: ${snapshot.meta.program_id}\n` +
        `  --program-id: ${args.programId}\n` +
        `Verify the snapshot was produced against the correct program before submitting.`
    );
  }

  // Step 4: Dry-run exits here — no RPC, no send.
  if (args.dryRun) {
    return result;
  }

  // Step 5: --yes guard.  This must come before any send logic so that calling
  // runSubmitRoot directly with dryRun=false, yes=false never reaches the send
  // path regardless of what deps are provided.
  if (!args.yes) {
    throw new Error("runSubmitRoot: --yes is required to submit a root");
  }

  if (!deps) {
    throw new Error("runSubmitRoot: deps are required in --yes mode");
  }

  if (args.commitment === "processed") {
    console.warn(
      `[WARN] --commitment processed was selected for this submission run. ` +
        `processed commitment is unsafe for roots that may gate withdrawals with ` +
        `real value. Use confirmed for the devnet alpha and finalized before any ` +
        `production root registration. See docs/indexer_finality_policy.md.`
    );
  }

  // Step 6: Derive config PDA.
  let programPubkey: PublicKey;
  try {
    programPubkey = new PublicKey(args.programId);
  } catch {
    throw new Error(`runSubmitRoot: invalid program ID: ${args.programId}`);
  }
  const [configPda] = deriveConfigPda(programPubkey);

  // Step 7: Fetch and validate config.
  const config = await deps.fetchConfig(configPda);
  if (config === null) {
    throw new Error(
      `verifier_config PDA not found at ${configPda.toBase58()}. ` +
        `Run init_devnet.ts first.`
    );
  }

  console.log(
    `  admin_authority:          ${config.adminAuthority.toBase58()}`
  );
  console.log(
    `  root_submitter_authority: ${config.rootSubmitterAuthority.toBase58()}`
  );

  if (!config.rootSubmitterAuthority.equals(deps.rootSubmitterPubkey)) {
    throw new Error(
      `root_submitter_authority mismatch:\n` +
        `  config: ${config.rootSubmitterAuthority.toBase58()}\n` +
        `  wallet: ${deps.rootSubmitterPubkey.toBase58()}\n` +
        `The wallet must be root_submitter_authority to call addAllowedRoot.`
    );
  }

  if (config.paused) {
    // addAllowedRoot does not check paused on-chain, but warn the operator.
    console.warn(
      `[WARN] Protocol is paused — addAllowedRoot will succeed, ` +
        `but withdrawals are blocked while paused.`
    );
  }

  const rootBytes = Array.from(
    Buffer.from(snapshot.last_root_be_hex, "hex")
  ) as number[];

  const alreadyPresent = config.allowedRoots.some((r) =>
    rootBytesMatch(r, rootBytes)
  );
  if (alreadyPresent) {
    if (args.allowExisting) {
      result.postSendVerified = true;
      return result;
    }
    throw new Error(
      `root is already present in allowed_roots. ` +
        `Use --allow-existing to treat this as a no-op success.`
    );
  }

  if (config.allowedRoots.length >= MAX_ROOTS - 2) {
    console.warn(
      `[WARN] allowed_roots is at ${config.allowedRoots.length}/${MAX_ROOTS}. ` +
        `Remove a root with removeAllowedRoot before the list is full.`
    );
  }

  if (config.allowedRoots.length >= MAX_ROOTS) {
    throw new Error(
      `allowed_roots is full (${config.allowedRoots.length}/${MAX_ROOTS}). ` +
        `Remove a root with removeAllowedRoot before adding new ones.`
    );
  }

  // Step 8: Send exactly one transaction.
  const txSig = await deps.sendAddAllowedRoot(rootBytes);
  result.sent = true;
  result.txSignature = txSig;

  // Step 9: Post-send verification.
  const updated = await deps.refetchConfig(configPda);
  if (updated === null) {
    throw new Error(
      `post-send config fetch failed: verifier_config PDA not found.`
    );
  }
  const rootNowPresent = updated.allowedRoots.some((r) =>
    rootBytesMatch(r, rootBytes)
  );
  if (!rootNowPresent) {
    throw new Error(
      `post-send verification failed: root not found in allowed_roots after transaction. ` +
        `Investigate on-chain state before retrying.`
    );
  }
  result.postSendVerified = true;

  return result;
}

// ── Argument parsing ───────────────────────────────────────────────────────────

const VALUED_FLAGS = new Set([
  "--snapshot",
  "--program-id",
  "--commitment",
  "--expected-root",
]);

const BOOL_FLAGS = new Set(["--dry-run", "--yes", "--allow-existing"]);

export function parseArgs(argv: string[]): SubmitRootArgs {
  let snapshotPath: string | undefined;
  let programId: string | undefined;
  let commitment: "confirmed" | "finalized" | "processed" = "confirmed";
  let expectedRoot: string | undefined;
  let allowExisting = false;
  let dryRun = false;
  let yes = false;

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
          `parseArgs: ${flag} requires a value but none was provided`
        );
      }
      switch (flag) {
        case "--snapshot":
          snapshotPath = next;
          break;
        case "--program-id":
          programId = next;
          break;
        case "--commitment":
          if (
            next !== "confirmed" &&
            next !== "finalized" &&
            next !== "processed"
          ) {
            throw new Error(
              `parseArgs: --commitment must be confirmed, finalized, or processed; got: ${next}`
            );
          }
          commitment = next;
          break;
        case "--expected-root":
          expectedRoot = next;
          break;
      }
      i += 2;
    } else if (BOOL_FLAGS.has(flag)) {
      switch (flag) {
        case "--dry-run":
          dryRun = true;
          break;
        case "--yes":
          yes = true;
          break;
        case "--allow-existing":
          allowExisting = true;
          break;
      }
      i++;
    } else {
      throw new Error(`parseArgs: unknown flag: ${flag}`);
    }
  }

  if (snapshotPath === undefined) {
    throw new Error("parseArgs: --snapshot is required");
  }
  if (programId === undefined) {
    throw new Error("parseArgs: --program-id is required");
  }
  if (dryRun && yes) {
    throw new Error("parseArgs: --dry-run and --yes are mutually exclusive");
  }

  return {
    snapshotPath,
    programId,
    commitment,
    expectedRoot,
    allowExisting,
    dryRun,
    yes,
  };
}

// ── Help text ──────────────────────────────────────────────────────────────────

/**
 * Usage text for --help / -h. Examples use angle-bracket placeholders only;
 * they intentionally contain no concrete wallet paths.
 */
export function helpText(): string {
  return [
    "submit_root_devnet.ts — guarded operator script to submit a verified Merkle",
    "root to the on-chain allowed_roots registry via addAllowedRoot.",
    "",
    "Devnet only. This must NOT be pointed at a mainnet RPC. Root submission is",
    "operator-managed; testers do not submit roots.",
    "",
    "Usage:",
    "  npx ts-node --project tsconfig.json scripts/ops/submit_root_devnet.ts \\",
    "    --snapshot <snapshot-path> --program-id <program-id> [options]",
    "",
    "Required flags:",
    "  --snapshot <path>        Indexer snapshot JSON to validate (full tree replay).",
    "  --program-id <pubkey>    Program ID the snapshot was produced against.",
    "",
    "Optional flags:",
    "  --expected-root <64-hex> Guard: must equal the snapshot's derived root.",
    "  --commitment <confirmed|finalized|processed>",
    "                           Commitment level (default: confirmed).",
    "  --dry-run                Validate the snapshot and preview the root. No RPC",
    "                           connection, no wallet, no transaction.",
    "  --yes                    Open RPC, read the wallet, run the read-only preflight,",
    "                           and send exactly one addAllowedRoot transaction.",
    "  --allow-existing         Treat an already-present root as a no-op success.",
    "  --help, -h               Print this help and exit.",
    "",
    "Modes:",
    "  (no flag)  Print intent and exit. No RPC connection, no wallet, no transaction.",
    "  --dry-run  Validate the snapshot only. No RPC connection, no wallet, no transaction.",
    "  --yes      Open RPC, read the wallet, run the preflight, then send exactly one",
    "             addAllowedRoot transaction. Requires explicit approval.",
    "  --dry-run and --yes are mutually exclusive.",
    "",
    "Environment (required for --yes only):",
    "  ANCHOR_PROVIDER_URL=<devnet-rpc>        Cluster RPC endpoint (must not be mainnet).",
    "  ANCHOR_WALLET=<root-submitter-wallet>   root_submitter authority signing wallet.",
    "",
    "This script does not deposit, does not withdraw, does not generate keys, and does",
    "not request airdrops. Submitting a root is not ZK proof verification.",
    "",
    "Examples:",
    "  # Dry-run: validate the snapshot and preview the root (no RPC, no transaction):",
    "  npx ts-node --project tsconfig.json scripts/ops/submit_root_devnet.ts \\",
    "    --snapshot <snapshot-path> --program-id <program-id> --dry-run",
    "",
    "  # Submit: send exactly one addAllowedRoot transaction (operator-managed):",
    "  ANCHOR_PROVIDER_URL=<devnet-rpc> ANCHOR_WALLET=<root-submitter-wallet> \\",
    "    npx ts-node --project tsconfig.json scripts/ops/submit_root_devnet.ts \\",
    "    --snapshot <snapshot-path> --program-id <program-id> --yes",
  ].join("\n");
}

/**
 * Path-safe copy-paste hint for the live submit command. Uses placeholders only —
 * it never echoes the local snapshot path or a concrete wallet/keypair path. The
 * operational `Snapshot:` field above still shows the real input; this is the
 * copy-paste line, so it stays OPSEC-clean.
 */
export function buildSubmitHint(): string {
  return (
    "  ANCHOR_PROVIDER_URL=<devnet-rpc-url> ANCHOR_WALLET=<root-submitter-keypair-path> \\\n" +
    "    npx ts-node --project tsconfig.json scripts/ops/submit_root_devnet.ts \\\n" +
    "    --snapshot <snapshot-path> --program-id <program-id> \\\n" +
    "    --expected-root <root> --commitment <commitment> --yes"
  );
}

// ── Internal helpers (CLI path only) ──────────────────────────────────────────

const IDL_CANDIDATES = [
  path.join(
    __dirname,
    "..",
    "..",
    "target",
    "idl",
    "shielded_pool_anchor.json"
  ),
  path.join(__dirname, "..", "..", "idl", "shielded_pool_anchor.json"),
];

function resolveIdlPath(): string {
  const found = IDL_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      "IDL not found. Tried:\n" +
        IDL_CANDIDATES.map((p) => `  - ${p}`).join("\n") +
        "\nRun anchor build first."
    );
  }
  return found;
}

function readKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ── CLI entry point ────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);

    // --help / -h is handled before required-flag validation so it never
    // requires --snapshot/--program-id and always exits cleanly.
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(helpText());
      return process.exit(0);
    }

    const args = (() => {
      try {
        return parseArgs(argv);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    // Env vars are only required in --yes mode.  No-flag mode and --dry-run
    // never open an RPC connection or load a wallet.
    const rpcUrl = process.env.ANCHOR_PROVIDER_URL;
    const walletPath = process.env.ANCHOR_WALLET;

    if (args.yes) {
      if (!rpcUrl) {
        console.error("ANCHOR_PROVIDER_URL not set");
        process.exit(1);
      }
      if (!walletPath) {
        console.error("ANCHOR_WALLET not set");
        process.exit(1);
      }
      if (rpcUrl.includes("mainnet")) {
        console.error(
          "ANCHOR_PROVIDER_URL appears to point to mainnet. " +
            "This script is for devnet alpha only."
        );
        process.exit(1);
      }
    }

    // Derive config PDA for display (all modes).
    let configPdaStr = "(unknown — invalid --program-id)";
    try {
      const [configPda] = deriveConfigPda(new PublicKey(args.programId));
      configPdaStr = configPda.toBase58();
    } catch {
      // non-fatal for display; runSubmitRoot will throw if needed
    }

    console.log(`Snapshot:         ${args.snapshotPath}`);
    console.log(`Program ID:       ${args.programId}`);
    console.log(`Config PDA:       ${configPdaStr}`);
    console.log(`Commitment:       ${args.commitment}`);
    if (args.expectedRoot !== undefined) {
      console.log(`Expected root:    ${args.expectedRoot}`);
    }
    if (args.allowExisting) {
      console.log(`Allow existing:   true`);
    }

    if (args.dryRun) {
      let result;
      try {
        result = await runSubmitRoot(args);
      } catch (err) {
        console.error(`\nerror: ${(err as Error).message}`);
        process.exit(1);
      }
      console.log(`\n[DRY RUN] No transaction sent. No RPC connection opened.`);
      console.log(`  snapshot_version:  ${result.snapshotVersion}`);
      console.log(`  leaf_count:        ${result.leafCount}`);
      console.log(`  event_count:       ${result.eventCount}`);
      console.log(`  would_submit_root: ${result.root}`);
      console.log(`  dry_run:           true`);
      console.log(`  sent:              false`);
      console.log(`  submitted:         false`);
      if (result.snapshotVersion >= 2 && result.snapshotMeta !== undefined) {
        console.log(
          `  fetch_commitment:  ${
            result.snapshotMeta.fetch_commitment ?? "(none)"
          }`
        );
        console.log(
          `  source_mode:       ${result.snapshotMeta.source_mode ?? "(none)"}`
        );
        console.log(
          `  created_at:        ${result.snapshotMeta.created_at ?? "(none)"}`
        );
        if (result.snapshotMeta.program_id !== undefined) {
          console.log(`  meta_program_id:   ${result.snapshotMeta.program_id}`);
        }
      }
      console.log(
        `\nTo submit, run with --yes (requires ANCHOR_PROVIDER_URL and ANCHOR_WALLET):`
      );
      console.log(buildSubmitHint());
      return;
    }

    if (!args.yes) {
      // Neither --dry-run nor --yes: print safety message and exit.
      // No env vars needed, no RPC opened, no wallet loaded.
      console.log(`\nNo transaction sent. No RPC connection opened.`);
      console.log(
        `Use --dry-run for a static preview without any network access.`
      );
      console.log(`Use --yes only after explicit approval.`);
      console.log(
        `\nWith --yes this will send exactly one addAllowedRoot transaction.`
      );
      console.log(
        `  The root will be added to allowed_roots in the on-chain verifier_config.`
      );
      console.log(
        `  Root submission is not ZK proof verification and does not enable withdraw_zk.`
      );
      console.log(
        `  Do not submit roots repeatedly; check if already present first.`
      );
      console.log(`\nRe-run with --yes to confirm:`);
      console.log(buildSubmitHint());
      process.exit(1);
    }

    // ── Confirmed send path ───────────────────────────────────────────────────
    // @anchor-lang/core is required only here to avoid loading Anchor workspace
    // when this module is imported in tests.
    const anchor =
      require("@anchor-lang/core") as typeof import("@anchor-lang/core");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idl: any = (() => {
      try {
        return JSON.parse(fs.readFileSync(resolveIdlPath(), "utf8"));
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    const idlProgramId = (() => {
      try {
        return validateIdlAddress(idl);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    // Cross-check: --program-id CLI arg must match the IDL address.
    try {
      const cliPk = new PublicKey(args.programId);
      if (cliPk.toBase58() !== idlProgramId.toBase58()) {
        console.error(
          `--program-id does not match IDL address:\n` +
            `  --program-id: ${cliPk.toBase58()}\n` +
            `  IDL address:  ${idlProgramId.toBase58()}\n` +
            `Verify you are using the correct --program-id and IDL.`
        );
        process.exit(1);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    const rootSubmitterKeypair = (() => {
      try {
        return readKeypair(walletPath!);
      } catch (err) {
        console.error(
          `Cannot read wallet at ${walletPath}: ${(err as Error).message}`
        );
        return process.exit(1);
      }
    })();

    console.log(
      `Root submitter (wallet): ${rootSubmitterKeypair.publicKey.toBase58()}`
    );
    console.log(`\n[!] Sending addAllowedRoot transaction...`);

    const connection = new anchor.web3.Connection(rpcUrl!, args.commitment);
    const wallet = new anchor.Wallet(rootSubmitterKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: args.commitment,
    });
    anchor.setProvider(provider);
    const program = new anchor.Program(idl, provider);

    const [configPda] = deriveConfigPda(new PublicKey(args.programId));

    const deps: SubmitRootDeps = {
      rootSubmitterPubkey: rootSubmitterKeypair.publicKey,
      fetchConfig: async (pda) => {
        return (await (program.account as any).verifierConfig.fetch(
          pda
        )) as VerifierConfigData;
      },
      sendAddAllowedRoot: async (root) => {
        return await (program.methods as any)
          .addAllowedRoot(root)
          .accounts({
            rootSubmitter: rootSubmitterKeypair.publicKey,
            config: configPda,
          })
          .rpc();
      },
      refetchConfig: async (pda) => {
        return (await (program.account as any).verifierConfig.fetch(
          pda
        )) as VerifierConfigData;
      },
    };

    try {
      const result = await runSubmitRoot(args, deps);
      console.log(`\nResult:`);
      console.log(`  leaf_count:         ${result.leafCount}`);
      console.log(`  root:               ${result.root}`);
      console.log(`  sent:               ${result.sent}`);
      console.log(`  tx:                 ${result.txSignature ?? "(none)"}`);
      console.log(`  post_send_verified: ${result.postSendVerified}`);
      if (result.sent && result.postSendVerified) {
        console.log(`\nRoot successfully added to allowed_roots.`);
        console.log(
          `Verify with: solana account ${configPdaStr} --url ${rpcUrl}`
        );
      }
    } catch (err) {
      console.error(`\nerror: ${(err as Error).message}`);
      process.exit(1);
    }
  })();
}
