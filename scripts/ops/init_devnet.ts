#!/usr/bin/env ts-node
/**
 * One-shot devnet initialization using persistent committee keys.
 *
 * Calls initializePool and initializeConfig on the deployed program.
 * Does NOT re-initialize if PDAs already exist.
 *
 * Required environment variables:
 *   ANCHOR_PROVIDER_URL — https://api.devnet.solana.com
 *   ANCHOR_WALLET       — path to admin keypair (becomes admin_authority)
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=<ADMIN_KEYPAIR> \
 *   npx ts-node scripts/ops/init_devnet.ts [--threshold N] [--chain-id N] [--dry-run]
 */

import * as fs from "fs";
import * as path from "path";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { Idl } from "@anchor-lang/core";

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
        "\nRun anchor build or anchor deploy first so target/idl/shielded_pool_anchor.json exists."
    );
  }
  return found;
}

const IDL_PATH = resolveIdlPath();
const VERIFIER_KEY_PATHS = [
  path.join(__dirname, "..", "..", "keys", "committee_keys", "verifier_1.json"),
  path.join(__dirname, "..", "..", "keys", "committee_keys", "verifier_2.json"),
  path.join(__dirname, "..", "..", "keys", "committee_keys", "verifier_3.json"),
];

const args = process.argv.slice(2);
const getArg = (flag: string, def: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};

const THRESHOLD = parseInt(getArg("--threshold", "1"), 10);
const CHAIN_ID = new BN(getArg("--chain-id", "1"));
const DRY_RUN = args.includes("--dry-run");

function readKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL;
  const walletPath = process.env.ANCHOR_WALLET;
  if (!rpcUrl) throw new Error("ANCHOR_PROVIDER_URL not set");
  if (!walletPath) throw new Error("ANCHOR_WALLET not set");

  if (rpcUrl.includes("mainnet")) {
    throw new Error("ANCHOR_PROVIDER_URL points to mainnet — aborting");
  }

  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const adminKeypair = readKeypair(walletPath);
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as Idl;
  const programId = new PublicKey(idl.address);
  const program = new anchor.Program(idl, provider);

  if (DRY_RUN) {
    console.log("[DRY RUN] No transactions will be sent.\n");
    console.log(
      "DRY RUN: wallet file loaded only to display intended admin public key; no transaction will be signed or sent."
    );
    console.log();
  }

  const programInfo = await connection.getAccountInfo(programId);
  if (!programInfo) {
    throw new Error(
      `Program account not found on devnet: ${programId.toBase58()}\nDeploy the program first with scripts/deploy_devnet.sh`
    );
  }

  console.log(`Program ID:       ${programId.toBase58()}`);
  console.log(`Admin (payer):    ${adminKeypair.publicKey.toBase58()}`);
  console.log(`Threshold:        ${THRESHOLD}`);
  console.log(`Chain ID:         ${CHAIN_ID.toString()}`);

  // Load verifier pubkeys from on-disk committee keys
  const verifierPubkeys: PublicKey[] = VERIFIER_KEY_PATHS.map((p, i) => {
    const kp = readKeypair(p);
    console.log(`Verifier ${i + 1}:       ${kp.publicKey.toBase58()}`);
    return kp.publicKey;
  });

  if (THRESHOLD < 1 || THRESHOLD > verifierPubkeys.length) {
    throw new Error(
      `Invalid threshold ${THRESHOLD} for ${verifierPubkeys.length} verifiers`
    );
  }

  if (THRESHOLD === 1 && verifierPubkeys.length > 1) {
    console.warn(
      `\n⚠  threshold=1 with ${verifierPubkeys.length} verifiers:` +
        `\n   Any single verifier key can authorize withdrawals alone.` +
        `\n   Consider --threshold 2 for better operational security if keys are independently held.` +
        `\n   See docs/DEVNET_ALPHA_RUNBOOK.md §5.4\n`
    );
  }

  // PDA derivation
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    programId
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    programId
  );
  console.log(`Pool PDA:         ${poolPda.toBase58()}`);
  console.log(`Config PDA:       ${configPda.toBase58()}`);

  // Check if already initialized
  const poolInfo = await connection.getAccountInfo(poolPda);
  if (poolInfo) {
    console.log("Pool PDA:         already exists — skipping initializePool");
  } else {
    if (DRY_RUN) {
      console.log("DRY RUN: would call initializePool()");
      console.log(`         authority: ${adminKeypair.publicKey.toBase58()}`);
      console.log(`         poolState: ${poolPda.toBase58()}`);
    } else {
      console.log("Initializing pool PDA…");
      const txPool = await (program.methods as any)
        .initializePool()
        .accounts({
          authority: adminKeypair.publicKey,
          poolState: poolPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`initializePool tx: ${txPool}`);
    }
  }

  const configInfo = await connection.getAccountInfo(configPda);
  if (configInfo) {
    console.log("Config PDA:       already exists — skipping initializeConfig");
  } else {
    if (DRY_RUN) {
      console.log(
        "DRY RUN: would call initializeConfig(attesterPubkey, verifierPubkeys, threshold, chainId)"
      );
      console.log(`         attester:  ${verifierPubkeys[0].toBase58()}`);
      console.log(`         admin:     ${adminKeypair.publicKey.toBase58()}`);
      console.log(`         config:    ${configPda.toBase58()}`);
      console.log(
        `         threshold: ${THRESHOLD}-of-${verifierPubkeys.length}`
      );
      console.log(`         chain_id:  ${CHAIN_ID.toString()}`);
      verifierPubkeys.forEach((pk, i) =>
        console.log(`         verifier[${i}]: ${pk.toBase58()}`)
      );
    } else {
      console.log("Initializing verifier config PDA…");
      const txConfig = await (program.methods as any)
        .initializeConfig(
          verifierPubkeys[0],
          verifierPubkeys,
          THRESHOLD,
          CHAIN_ID
        )
        .accounts({
          admin: adminKeypair.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`initializeConfig tx: ${txConfig}`);
    }
  }

  console.log(
    DRY_RUN
      ? "\nDry run complete — 0 transactions sent."
      : "\nInitialization complete."
  );
  console.log(
    "Verify with the operator admin flow (--print) using the admin wallet on devnet."
  );
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
