#!/usr/bin/env ts-node
/**
 * One-shot devnet script to create a NoteDeposited event via depositNote.
 *
 * Sends exactly one depositNote transaction when run with --yes.
 * Transfers denomination lamports from the depositor wallet to pool_state
 * and appends a leaf to note_tree_state.
 *
 * Required environment variables:
 *   ANCHOR_PROVIDER_URL — cluster RPC endpoint (must not be mainnet)
 *   ANCHOR_WALLET       — path to depositor keypair
 *
 * Modes:
 *   --dry-run   Derives and prints static values only. Reads ANCHOR_WALLET
 *               to display the depositor public key. Opens no RPC connection;
 *               performs no on-chain checks (account existence, pause state,
 *               or balance). No transaction sent.
 *   --yes       Opens RPC, runs all read-only prechecks, then sends exactly
 *               one depositNote transaction. Requires explicit approval.
 *   (neither)   Prints intent and exits without sending. No RPC connection
 *               opened. No prechecks run.
 *
 * Optional flags:
 *   --commitment <64-char-hex>   Commitment to deposit. Must be a canonical
 *                                BN254 Fr element (non-zero, < modulus).
 *                                Defaults to SMOKE_COMMITMENT if omitted.
 *   --denomination <decimal-u64> Lamport amount. Must be in ALLOWED_BUCKET_AMOUNTS.
 *                                Defaults to 1,000 (bucket 1) if omitted.
 *
 * Preconditions verified before sending (--yes path only):
 *   - pool_state PDA exists
 *   - verifier_config PDA exists and protocol is not paused
 *   - note_tree_state PDA exists (run init_note_tree_devnet.ts --yes first)
 *   - depositor has sufficient balance (denomination + transaction fees)
 *
 * Does not submit roots. Does not call the ZK withdraw instruction.
 * Does not generate keypairs. Does not call airdrop methods.
 * SMOKE_COMMITMENT is a public test vector, not a private secret.
 */

import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";

// Smallest allowed denomination bucket: 1,000 lamports per ALLOWED_BUCKET_AMOUNTS.
export const DENOMINATION = 1_000;

// On-chain allowed bucket amounts (must match ALLOWED_BUCKET_AMOUNTS in constants.rs).
export const ALLOWED_BUCKET_AMOUNTS: readonly number[] = [
  1_000, 100_000_000, 1_000_000_000, 10_000_000_000, 100_000_000_000,
];

// BN254 Fr modulus used to validate commitment canonicality.
export const BN254_FR_MODULUS = Buffer.from([
  0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81,
  0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1,
  0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
]);

// Deterministic smoke commitment: non-zero, canonical BN254 Fr element.
// Identical to VALID_COMMITMENT in tests/deposit_note.ts — a public test
// vector. Not a private secret; not for production use.
export const SMOKE_COMMITMENT = Buffer.from([
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89,
  0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23,
  0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
]);

const U64_MAX = 18446744073709551615n;

// ── Commitment validation helpers ─────────────────────────────────────────────

/** Interprets a Buffer as a big-endian unsigned integer. */
export function bufferToBigIntBE(buf: Buffer): bigint {
  let result = 0n;
  for (const byte of buf) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

/**
 * Validates that a commitment buffer is a canonical BN254 Fr element:
 * exactly 32 bytes, non-zero, and strictly less than BN254_FR_MODULUS.
 * Throws a descriptive error on any violation.
 */
export function validateSmokeCommitment(commitment: Buffer): void {
  if (commitment.length !== 32) {
    throw new Error(
      `Commitment must be exactly 32 bytes; got ${commitment.length}`
    );
  }
  if (commitment.every((b) => b === 0)) {
    throw new Error("Commitment must not be the zero element");
  }
  if (bufferToBigIntBE(commitment) >= bufferToBigIntBE(BN254_FR_MODULUS)) {
    throw new Error(
      "Commitment is not a canonical BN254 Fr element (>= modulus)"
    );
  }
}

/**
 * Parses a 64-char hex string into a validated 32-byte commitment Buffer.
 * Rejects non-hex, wrong length, zero value, and values >= BN254_FR_MODULUS.
 */
export function parseCommitmentHex(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `--commitment must be exactly 64 hex characters (32 bytes); got: ${JSON.stringify(
        hex
      )}`
    );
  }
  const buf = Buffer.from(hex.toLowerCase(), "hex");
  validateSmokeCommitment(buf);
  return buf;
}

/**
 * Parses a decimal string into a validated denomination number.
 * Must be a positive decimal integer in ALLOWED_BUCKET_AMOUNTS and <= u64 max.
 */
export function parseDenomination(s: string): number {
  if (!/^\d+$/.test(s)) {
    throw new Error(
      `--denomination must be a decimal integer; got: ${JSON.stringify(s)}`
    );
  }
  let n: bigint;
  try {
    n = BigInt(s);
  } catch {
    throw new Error(
      `--denomination is not a valid integer: ${JSON.stringify(s)}`
    );
  }
  if (n > U64_MAX) {
    throw new Error(
      `--denomination exceeds u64 maximum (${U64_MAX}); got: ${s}`
    );
  }
  const val = Number(n);
  if (!ALLOWED_BUCKET_AMOUNTS.includes(val)) {
    throw new Error(
      `--denomination ${s} is not an allowed bucket amount; valid values: ${ALLOWED_BUCKET_AMOUNTS.join(
        ", "
      )}`
    );
  }
  return val;
}

// ── Program ID validation ─────────────────────────────────────────────────────

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

// ── PDA derivations ───────────────────────────────────────────────────────────

export function derivePoolStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    programId
  );
}

export function deriveConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    programId
  );
}

export function deriveNoteTreePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("note_tree")],
    programId
  );
}

// ── Argument parsing ──────────────────────────────────────────────────────────

export interface DepositNoteScriptArgs {
  dryRun: boolean;
  yes: boolean;
  commitment: Buffer;
  denomination: number;
}

export function parseArgs(argv: string[]): DepositNoteScriptArgs {
  let dryRun = false;
  let yes = false;
  let commitmentBuf: Buffer | undefined;
  let denominationVal: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      dryRun = true;
    } else if (flag === "--yes") {
      yes = true;
    } else if (flag === "--commitment") {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error("--commitment requires a 64-char hex value");
      }
      commitmentBuf = parseCommitmentHex(val);
      i++;
    } else if (flag === "--denomination") {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error("--denomination requires a decimal integer value");
      }
      denominationVal = parseDenomination(val);
      i++;
    } else {
      throw new Error(`parseArgs: unknown flag: ${flag}`);
    }
  }

  return {
    dryRun,
    yes,
    commitment: commitmentBuf ?? SMOKE_COMMITMENT,
    denomination: denominationVal ?? DENOMINATION,
  };
}

export function buildYesFlagPreview(args: DepositNoteScriptArgs): string[] {
  const flags: string[] = [];
  if (!args.commitment.equals(SMOKE_COMMITMENT)) {
    flags.push(`--commitment ${args.commitment.toString("hex")}`);
  }
  if (args.denomination !== DENOMINATION) {
    flags.push(`--denomination ${args.denomination}`);
  }
  flags.push("--yes");
  return flags;
}

/**
 * Builds the post-deposit "Index the event" hint. Root derivation reads the note
 * tree, so the indexed `--address` is the note tree PDA (not the program id);
 * `--program-id` stays the program id. This is a printed next-step hint only — it
 * does not affect the deposit transaction.
 */
export function buildIndexerHint(params: {
  rpcUrl: string;
  noteTreeAddress: string;
  programId: string;
}): string {
  return [
    `Index the event (read-only, --dry-run):`,
    `  npx ts-node scripts/zk_indexer_rpc_fetch.ts \\`,
    `    --rpc-url ${params.rpcUrl} \\`,
    `    --address ${params.noteTreeAddress} \\`,
    `    --program-id ${params.programId} \\`,
    `    --idl idl/shielded_pool_anchor.json \\`,
    `    --decoder anchor-event-parser \\`,
    `    --output <indexer-output-path-outside-repo> \\`,
    `    --limit 10 \\`,
    `    --commitment confirmed \\`,
    `    --dry-run`,
  ].join("\n");
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
        "\nRun anchor build first so target/idl/shielded_pool_anchor.json exists."
    );
  }
  return found;
}

function readKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    // Fail closed if SMOKE_COMMITMENT has been edited to an invalid value.
    (() => {
      try {
        validateSmokeCommitment(SMOKE_COMMITMENT);
      } catch (err) {
        console.error(
          `SMOKE_COMMITMENT constant is invalid: ${(err as Error).message}`
        );
        process.exit(1);
      }
    })();

    const argv = process.argv.slice(2);

    // `return process.exit(1)` in catch branches lets TypeScript infer each
    // const as its success type (T | never = T), avoiding non-null assertions.
    const args = (() => {
      try {
        return parseArgs(argv);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    const rpcUrl = process.env.ANCHOR_PROVIDER_URL;
    const walletPath = process.env.ANCHOR_WALLET;
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
          "This script is for devnet alpha only. Do not use with real funds."
      );
      process.exit(1);
    }

    // Load IDL and validate program ID against PROGRAM_ID constant.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idl: any = (() => {
      try {
        return JSON.parse(fs.readFileSync(resolveIdlPath(), "utf8"));
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();
    const programId = (() => {
      try {
        return validateIdlAddress(idl);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    const [poolStatePda] = derivePoolStatePda(programId);
    const [configPda] = deriveConfigPda(programId);
    const [noteTreePda] = deriveNoteTreePda(programId);

    // Wallet is read in both dry-run and live mode to display the depositor
    // public key. In dry-run mode no RPC connection is opened, no on-chain
    // checks are performed, and no transaction is signed or sent.
    const depositorKeypair = (() => {
      try {
        return readKeypair(walletPath);
      } catch (err) {
        console.error(
          `Cannot read wallet at ${walletPath}: ${(err as Error).message}`
        );
        return process.exit(1);
      }
    })();

    console.log(`Cluster:          ${rpcUrl}`);
    console.log(`Program ID:       ${programId.toBase58()}`);
    console.log(`Depositor:        ${depositorKeypair.publicKey.toBase58()}`);
    console.log(`pool_state PDA:   ${poolStatePda.toBase58()}`);
    console.log(`config PDA:       ${configPda.toBase58()}`);
    console.log(`note_tree PDA:    ${noteTreePda.toBase58()}`);
    console.log(`Denomination:     ${args.denomination} lamports`);
    console.log(`Commitment:       ${args.commitment.toString("hex")}`);
    if (args.commitment.equals(SMOKE_COMMITMENT)) {
      console.log(
        `                  (public smoke test vector — not a private secret)`
      );
    }

    if (args.dryRun) {
      console.log("\n[DRY RUN] No transaction sent. No RPC connection opened.");
      console.log(
        "  On-chain account existence, pause state, and balance are not checked."
      );
      console.log(
        "  These prechecks run only in the --yes path immediately before sending."
      );
      console.log(
        "  Wallet file was read to display the intended depositor public key;"
      );
      console.log("  no signing performed.");
      const yesFlags = buildYesFlagPreview(args);
      console.log("\nTo send the transaction, run with --yes:");
      console.log(
        `  ANCHOR_PROVIDER_URL=${rpcUrl} ANCHOR_WALLET=${walletPath} npx ts-node scripts/ops/deposit_note_devnet.ts ${yesFlags.join(
          " "
        )}`
      );
      return;
    }

    if (!args.yes) {
      console.log(
        "\nNo transaction sent. No RPC connection opened. No prechecks run."
      );
      console.log(
        "Use --dry-run for a static preview without any network access."
      );
      console.log("Use --yes only after explicit approval.");
      console.log(
        `\nWith --yes this will send exactly one depositNote transaction:`
      );
      console.log(
        `  ${args.denomination} lamports transferred from depositor to pool_state.`
      );
      if (args.commitment.equals(SMOKE_COMMITMENT)) {
        console.log(
          "  Commitment is a public smoke test vector. Not for production use."
        );
      }
      console.log("  No roots are submitted. No keypairs are generated.");
      console.log("\nRe-run with --yes to confirm:");
      const confirmFlags = buildYesFlagPreview(args);
      console.log(
        `  ANCHOR_PROVIDER_URL=${rpcUrl} ANCHOR_WALLET=${walletPath} npx ts-node scripts/ops/deposit_note_devnet.ts ${confirmFlags.join(
          " "
        )}`
      );
      process.exit(1);
    }

    // ── Confirmed send path ─────────────────────────────────────────────────
    // @anchor-lang/core is required only here to avoid loading the Anchor
    // workspace when this module is imported in tests.
    const anchor =
      require("@anchor-lang/core") as typeof import("@anchor-lang/core");

    const connection = new anchor.web3.Connection(rpcUrl, "confirmed");

    // Read-only prechecks before any transaction is sent.
    const poolInfo = await connection.getAccountInfo(poolStatePda);
    if (!poolInfo) {
      console.error(
        `pool_state PDA not found: ${poolStatePda.toBase58()}\n` +
          "Run init_devnet.ts first."
      );
      process.exit(1);
    }

    const configInfo = await connection.getAccountInfo(configPda);
    if (!configInfo) {
      console.error(
        `verifier_config PDA not found: ${configPda.toBase58()}\n` +
          "Run init_devnet.ts first."
      );
      process.exit(1);
    }

    const treeInfo = await connection.getAccountInfo(noteTreePda);
    if (!treeInfo) {
      console.error(
        `note_tree_state PDA not found: ${noteTreePda.toBase58()}\n` +
          "Run init_note_tree_devnet.ts --yes first."
      );
      process.exit(1);
    }

    const depositorBalance = await connection.getBalance(
      depositorKeypair.publicKey
    );
    const minBalance = args.denomination + 10_000;
    if (depositorBalance < minBalance) {
      console.error(
        `Depositor balance insufficient: ${depositorBalance} lamports ` +
          `(need at least ${minBalance} for denomination + fees)`
      );
      process.exit(1);
    }

    const wallet = new anchor.Wallet(depositorKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);
    const program = new anchor.Program(idl, provider);

    // Fetch verifier_config to check pause state before sending.
    const configAccount = await (program.account as any).verifierConfig.fetch(
      configPda
    );
    if (configAccount.paused) {
      console.error(
        "Protocol is paused — depositNote will be rejected.\n" +
          "Unpause first: run the operator admin flow (--unpause) with the admin wallet."
      );
      process.exit(1);
    }

    // Account names verified against tests/deposit_note.ts and the IDL
    // (depositNote accounts: depositor, pool_state, config, note_tree_state,
    // system_program — IDL snake_case mapped to Anchor JS camelCase).
    console.log("\nSending depositNote...");
    try {
      const tx = await (program.methods as any)
        .depositNote(
          Array.from(args.commitment),
          new anchor.BN(args.denomination)
        )
        .accounts({
          depositor: depositorKeypair.publicKey,
          poolState: poolStatePda,
          config: configPda,
          noteTreeState: noteTreePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`note deposited: ${tx}`);
      console.log(
        "\n" +
          buildIndexerHint({
            rpcUrl,
            noteTreeAddress: noteTreePda.toBase58(),
            programId: PROGRAM_ID,
          })
      );
    } catch (err) {
      console.error(`depositNote failed: ${(err as Error).message ?? err}`);
      process.exit(1);
    }
  })();
}
