#!/usr/bin/env ts-node
/**
 * One-shot devnet migration: upgrades legacy v1.6.3 PDAs to the current account layout.
 *
 * Calls migratePool and migrateConfig only when the on-chain account is at the
 * legacy size. Skips silently when already migrated.
 *
 * Required environment variables:
 *   ANCHOR_PROVIDER_URL — must not point to mainnet
 *   ANCHOR_WALLET       — path to admin keypair (must match admin_authority in config)
 *
 * Options:
 *   --attester <base58>   Attester pubkey to write into the migrated VerifierConfig
 *   --dry-run             Print what would happen without sending transactions
 *
 * Attester resolution order (first match wins):
 *   1. --attester <base58> flag
 *   2. <ATTESTER_KEYPAIR> on disk  (pubkey is read; private key is NOT used or logged)
 *   Script exits with an error if neither is available.
 *
 * Account size constants (must match programs/…/src/migration.rs):
 *   Legacy pool:    17 bytes   Current pool:    57 bytes
 *   Legacy config: 311 bytes   Previous config: 667 bytes   Current config: 699 bytes
 */

import * as fs from "fs";
import * as path from "path";
import * as anchor from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { Idl } from "@anchor-lang/core";

// ── Size constants — must match programs/shielded_pool_anchor/src/migration.rs ──
const LEGACY_POOL_LEN = 17;
const CURRENT_POOL_LEN = 57;
const LEGACY_CONFIG_LEN = 311;
const PREV_CONFIG_LEN = 667;
const CURRENT_CONFIG_LEN = 699;

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
        "\nRun `anchor build` first."
    );
  }
  return found;
}

function readKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const cliArgs = process.argv.slice(2);
const getFlag = (flag: string): string | undefined => {
  const i = cliArgs.indexOf(flag);
  return i >= 0 && i + 1 < cliArgs.length ? cliArgs[i + 1] : undefined;
};
const DRY_RUN = cliArgs.includes("--dry-run");

function resolveAttester(): PublicKey {
  const flag = getFlag("--attester");
  if (flag) {
    return new PublicKey(flag);
  }
  const keyPath = path.join(__dirname, "..", "..", "keys", "attester.json");
  if (fs.existsSync(keyPath)) {
    const kp = readKeypair(keyPath);
    // Only the public key is used; private key is not logged or transmitted.
    console.log(
      `Attester: loaded pubkey from ${path.relative(process.cwd(), keyPath)}`
    );
    return kp.publicKey;
  }
  throw new Error(
    "Attester pubkey not provided.\n" +
      "Pass --attester <base58> or place <ATTESTER_KEYPAIR> on disk."
  );
}

// ── Canonicality check — mirrors is_canonical_config() in migration.rs ───────
// Returns true iff the 699-byte config account has valid Borsh Vec structure
// and the bump byte at the dynamic Borsh position equals expectedBump.
// Trailing bytes after the bump are ignored; they may be stale from root ops.
//   verifier_len (u32 LE) at offset 114
//   roots_off    = 118 + verifier_len * 32
//   roots_len (u32 LE) at roots_off
//   bump         at roots_off + 4 + roots_len * 32  must equal expectedBump
function isCanonicalConfig(data: Buffer, expectedBump: number): boolean {
  if (data.length !== CURRENT_CONFIG_LEN) return false;
  const nVerifiers = data.readUInt32LE(114);
  if (nVerifiers > 8) return false; // MAX_VERIFIERS
  const rootsOff = 118 + nVerifiers * 32;
  if (rootsOff + 4 > data.length) return false;
  const nRoots = data.readUInt32LE(rootsOff);
  if (nRoots > 10) return false; // MAX_ROOTS
  const bumpOff = rootsOff + 4 + nRoots * 32;
  if (bumpOff >= data.length) return false;
  return data[bumpOff] === expectedBump;
}

async function main() {
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL;
  const walletPath = process.env.ANCHOR_WALLET;
  if (!rpcUrl) throw new Error("ANCHOR_PROVIDER_URL not set");
  if (!walletPath) throw new Error("ANCHOR_WALLET not set");
  if (rpcUrl.includes("mainnet")) {
    throw new Error("ANCHOR_PROVIDER_URL points to mainnet — aborting");
  }

  const attesterPubkey = resolveAttester();
  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const adminKeypair = readKeypair(walletPath);
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(resolveIdlPath(), "utf8")) as Idl;
  const programId = new PublicKey(idl.address);
  const program = new anchor.Program(idl, provider);

  if (DRY_RUN) console.log("[DRY RUN] No transactions will be sent.\n");

  console.log(`Program ID:    ${programId.toBase58()}`);
  console.log(`Admin:         ${adminKeypair.publicKey.toBase58()}`);
  console.log(`Attester:      ${attesterPubkey.toBase58()}`);

  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    programId
  );
  const [configPda, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    programId
  );
  console.log(`Pool PDA:      ${poolPda.toBase58()}`);
  console.log(`Config PDA:    ${configPda.toBase58()}`);
  console.log();

  // ── Pool migration ────────────────────────────────────────────────────────
  const poolInfo = await connection.getAccountInfo(poolPda);
  if (!poolInfo) {
    console.log("Pool PDA:      not found on chain — skipping");
  } else {
    const before = poolInfo.data.length;
    console.log(
      `Pool PDA:      ${before} bytes  (legacy=${LEGACY_POOL_LEN}, current=${CURRENT_POOL_LEN})`
    );
    if (before === CURRENT_POOL_LEN) {
      console.log("Pool PDA:      already at current layout — skipping");
    } else if (before === LEGACY_POOL_LEN) {
      if (DRY_RUN) {
        console.log(
          `DRY RUN: would call migratePool(authority=${adminKeypair.publicKey.toBase58()})`
        );
      } else {
        console.log("Migrating pool PDA…");
        const tx = await (program.methods as any)
          .migratePool(adminKeypair.publicKey)
          .accounts({
            admin: adminKeypair.publicKey,
            poolState: poolPda,
            config: configPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        const afterInfo = await connection.getAccountInfo(poolPda);
        const after = afterInfo?.data.length ?? "??";
        console.log(`Pool PDA:      migrated ${before} → ${after} bytes`);
        console.log(`migratePool tx: ${tx}`);
      }
    } else {
      console.log(
        `Pool PDA:      unexpected size ${before} — manual inspection required`
      );
      process.exit(1);
    }
  }

  console.log();

  // ── Config migration ──────────────────────────────────────────────────────
  const configInfo = await connection.getAccountInfo(configPda);
  if (!configInfo) {
    console.log("Config PDA:    not found on chain — skipping");
  } else {
    const before = configInfo.data.length;
    console.log(
      `Config PDA:    ${before} bytes  (legacy=${LEGACY_CONFIG_LEN}, prev=${PREV_CONFIG_LEN}, current=${CURRENT_CONFIG_LEN})`
    );
    if (before === CURRENT_CONFIG_LEN) {
      if (isCanonicalConfig(configInfo.data, configBump)) {
        console.log("Config PDA:    canonical Borsh layout — skipping");
      } else {
        if (DRY_RUN) {
          console.log(
            "DRY RUN: would call migrateConfig to repair malformed current-size config"
          );
        } else {
          console.log(
            "Config PDA:    malformed current-size layout — repairing…"
          );
          const tx = await (program.methods as any)
            .migrateConfig(attesterPubkey)
            .accounts({
              admin: adminKeypair.publicKey,
              config: configPda,
              systemProgram: SystemProgram.programId,
            })
            .rpc();
          const afterInfo = await connection.getAccountInfo(configPda);
          const after = afterInfo?.data.length ?? "??";
          console.log(`Config PDA:    repaired ${before} → ${after} bytes`);
          console.log(`migrateConfig tx: ${tx}`);
        }
      }
    } else if (before === PREV_CONFIG_LEN || before === LEGACY_CONFIG_LEN) {
      if (DRY_RUN) {
        console.log(
          `DRY RUN: would call migrateConfig(attester=${attesterPubkey.toBase58()})`
        );
      } else {
        console.log("Migrating config PDA…");
        const tx = await (program.methods as any)
          .migrateConfig(attesterPubkey)
          .accounts({
            admin: adminKeypair.publicKey,
            config: configPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        const afterInfo = await connection.getAccountInfo(configPda);
        const after = afterInfo?.data.length ?? "??";
        console.log(`Config PDA:    migrated ${before} → ${after} bytes`);
        console.log(`migrateConfig tx: ${tx}`);
      }
    } else {
      console.log(
        `Config PDA:    unexpected size ${before} — manual inspection required`
      );
      process.exit(1);
    }
  }

  console.log();
  console.log(
    DRY_RUN ? "Dry run complete — 0 transactions sent." : "Migration complete."
  );
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
