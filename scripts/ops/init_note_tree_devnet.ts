#!/usr/bin/env ts-node
/**
 * One-shot devnet script to initialize the NoteTreeState PDA.
 *
 * Calls initNoteTree on the deployed program. Exits cleanly if the
 * note_tree_state account already exists (second call is idempotent).
 *
 * Required environment variables:
 *   ANCHOR_PROVIDER_URL — cluster RPC endpoint (must not be mainnet)
 *   ANCHOR_WALLET       — path to admin keypair (must be admin_authority)
 *
 * Usage:
 *   # Derive and print addresses; send no transaction, open no RPC connection:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=<ADMIN_KEYPAIR> \
 *   npx ts-node scripts/ops/init_note_tree_devnet.ts --dry-run
 *
 *   # Send the initNoteTree transaction (exactly one admin transaction):
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=<ADMIN_KEYPAIR> \
 *   npx ts-node scripts/ops/init_note_tree_devnet.ts --yes
 *
 * Does not call the note deposit instruction. Does not submit roots.
 * Does not generate keypairs.
 */

import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";

// ── Program ID validation ─────────────────────────────────────────────────────

/**
 * Validates the IDL address field against PROGRAM_ID. Returns the validated
 * PublicKey. Throws if the address is missing, is not a valid public key, or
 * does not match PROGRAM_ID.
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

// ── PDA derivation ────────────────────────────────────────────────────────────

export function deriveNoteTreePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("note_tree")],
    programId
  );
}

// ── Argument parsing ──────────────────────────────────────────────────────────

export interface NoteTreeScriptArgs {
  dryRun: boolean;
  yes: boolean;
}

export function parseArgs(argv: string[]): NoteTreeScriptArgs {
  let dryRun = false;
  let yes = false;

  for (const flag of argv) {
    if (flag === "--dry-run") dryRun = true;
    else if (flag === "--yes") yes = true;
    else throw new Error(`parseArgs: unknown flag: ${flag}`);
  }

  return { dryRun, yes };
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

    const [noteTreePda] = deriveNoteTreePda(programId);
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("verifier_config")],
      programId
    );

    // Wallet is read in both dry-run and live mode to display the intended
    // admin public key. In dry-run mode no transaction is signed or sent.
    const adminKeypair = (() => {
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
    console.log(`Admin (wallet):   ${adminKeypair.publicKey.toBase58()}`);
    console.log(`Config PDA:       ${configPda.toBase58()}`);
    console.log(`note_tree PDA:    ${noteTreePda.toBase58()}`);

    if (args.dryRun) {
      console.log(
        "\n[DRY RUN] No transaction will be sent. No RPC connection opened."
      );
      console.log(
        "  Wallet file was read to display the intended admin public key;"
      );
      console.log("  no signing performed.");
      console.log("\nTo send the transaction, run with --yes:");
      console.log(
        `  ANCHOR_PROVIDER_URL=${rpcUrl} ANCHOR_WALLET=${walletPath} npx ts-node scripts/ops/init_note_tree_devnet.ts --yes`
      );
      return;
    }

    if (!args.yes) {
      console.log(
        "\nThis will send exactly one admin transaction: initNoteTree."
      );
      console.log("  admin_authority must match the wallet shown above.");
      console.log(
        "  Idempotent: a second call fails safely (account already initialized)."
      );
      console.log("\nRe-run with --yes to confirm:");
      console.log(
        `  ANCHOR_PROVIDER_URL=${rpcUrl} ANCHOR_WALLET=${walletPath} npx ts-node scripts/ops/init_note_tree_devnet.ts --yes`
      );
      process.exit(1);
    }

    // ── Confirmed send path ─────────────────────────────────────────────────
    // @anchor-lang/core is required only here to avoid loading the Anchor
    // workspace when this module is imported in tests.
    const anchor =
      require("@anchor-lang/core") as typeof import("@anchor-lang/core");

    const connection = new anchor.web3.Connection(rpcUrl, "confirmed");

    // Pre-flight: check if note_tree_state already exists before sending.
    const existing = await connection.getAccountInfo(noteTreePda);
    if (existing) {
      console.log("\nnote_tree PDA:    already initialized — nothing to do.");
      console.log(
        `Verify with: solana account ${noteTreePda.toBase58()} --url ${rpcUrl}`
      );
      return;
    }

    // anchor.Wallet is confirmed exported from @anchor-lang/core (verified at
    // implementation time). It wraps the ANCHOR_WALLET keypair loaded above;
    // no keypairs are generated.
    const wallet = new anchor.Wallet(adminKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const program = new anchor.Program(idl, provider);

    // Account names verified against tests/init_note_tree.ts and the IDL
    // (init_note_tree instruction snapshot). IDL snake_case names
    // (admin, config, note_tree_state, system_program) are passed as
    // camelCase per Anchor JS client convention.
    console.log("\nSending initNoteTree...");
    try {
      const tx = await (program.methods as any)
        .initNoteTree()
        .accounts({
          admin: adminKeypair.publicKey,
          config: configPda,
          noteTreeState: noteTreePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`note_tree initialized: ${tx}`);
      console.log(
        `Verify with: solana account ${noteTreePda.toBase58()} --url ${rpcUrl}`
      );
    } catch (err) {
      const msg = String(err);
      if (
        msg.includes("already in use") ||
        msg.includes("AccountAlreadyInitialized")
      ) {
        console.log(
          "note_tree PDA:    already initialized (detected from error) — nothing to do."
        );
      } else {
        console.error(`initNoteTree failed: ${(err as Error).message ?? err}`);
        process.exit(1);
      }
    }
  })();
}
