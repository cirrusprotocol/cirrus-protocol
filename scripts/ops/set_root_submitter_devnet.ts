#!/usr/bin/env ts-node
/**
 * Guarded operator script to rotate root_submitter_authority via
 * setRootSubmitterAuthority.
 *
 * admin_authority is the only key that can rotate root_submitter_authority.
 * After rotation, root_submitter_authority controls the allowed-root add and
 * remove instructions; the admin wallet is no longer needed for routine root
 * submission.
 *
 * Required environment variables (--yes path only):
 *   ANCHOR_PROVIDER_URL  — cluster RPC endpoint (must not be mainnet)
 *   ANCHOR_WALLET        — path to admin keypair (must be admin_authority)
 *
 * Modes:
 *   --dry-run   Open RPC, fetch config PDA, print current and proposed
 *               root_submitter_authority.  No wallet needed.  No transaction
 *               sent.
 *   --yes       Open RPC, load ANCHOR_WALLET (admin), verify wallet equals
 *               admin_authority, send exactly one setRootSubmitterAuthority
 *               transaction, post-send verify.
 *   (neither)   Print safety message and exit non-zero.  No RPC connection.
 *               No env vars needed.
 *
 * --dry-run and --yes are mutually exclusive.
 *
 * Does not call the note-deposit instruction.
 * Does not call the ZK withdrawal instruction.
 * Does not call the allowed-root add or remove instructions.
 * Does not generate keypairs.  Does not request airdrops.
 * Does not submit roots.
 */

import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";

const DEFAULT_PUBKEY = "11111111111111111111111111111111";

// VerifierConfig account layout constants (must match the deployed program).
const VERIFIER_CONFIG_SIZE = 699;
const VERIFIER_CONFIG_DISCRIMINATOR = [176, 103, 248, 36, 138, 167, 176, 220];

// ── IDL validation ─────────────────────────────────────────────────────────────

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

export interface SetRootSubmitterArgs {
  newRootSubmitter: PublicKey | undefined;
  programId: string;
  commitment: "confirmed" | "finalized" | "processed";
  dryRun: boolean;
  yes: boolean;
}

export interface VerifierConfigData {
  adminAuthority: PublicKey;
  rootSubmitterAuthority: PublicKey;
}

export interface SetRootSubmitterDeps {
  adminPubkey: PublicKey;
  fetchConfig: (configPda: PublicKey) => Promise<VerifierConfigData | null>;
  sendSetRootSubmitter: (newRootSubmitter: PublicKey) => Promise<string>;
  refetchConfig: (configPda: PublicKey) => Promise<VerifierConfigData | null>;
}

export interface SetRootSubmitterResult {
  programId: string;
  configPda: string;
  dryRun: boolean;
  sent: boolean;
  noOp: boolean;
  txSignature: string | undefined;
  postSendVerified: boolean;
  adminAuthority: string | undefined;
  previousRootSubmitter: string | undefined;
  proposedRootSubmitter: string | undefined;
}

// ── PDA derivation ─────────────────────────────────────────────────────────────

export function deriveConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    programId
  );
}

// ── Core runner ────────────────────────────────────────────────────────────────

/**
 * Rotates root_submitter_authority to newRootSubmitter, or previews the
 * rotation in dry-run mode.
 *
 * deps is required in both --dry-run and --yes modes.
 *
 * Steps (--yes):
 *   1. Validate newRootSubmitter is present and not the default key.
 *   2. Derive configPda; fetchConfig via deps.
 *   3. Preflight: deps.adminPubkey must equal config.adminAuthority.
 *   4. No-op check: if proposed == current, return without sending.
 *   5. sendSetRootSubmitter — exactly one transaction.
 *   6. refetchConfig — verify rootSubmitterAuthority == newRootSubmitter.
 */
export async function runSetRootSubmitter(
  args: SetRootSubmitterArgs,
  deps?: SetRootSubmitterDeps
): Promise<SetRootSubmitterResult> {
  if (args.newRootSubmitter === undefined) {
    throw new Error("runSetRootSubmitter: --new-root-submitter is required");
  }

  const newKey = args.newRootSubmitter;
  if (newKey.toBase58() === DEFAULT_PUBKEY) {
    throw new Error(
      "runSetRootSubmitter: --new-root-submitter must not be the default (all-zero) key"
    );
  }

  let programPubkey: PublicKey;
  try {
    programPubkey = new PublicKey(args.programId);
  } catch {
    throw new Error(
      `runSetRootSubmitter: invalid program ID: ${args.programId}`
    );
  }
  const [configPda] = deriveConfigPda(programPubkey);

  const result: SetRootSubmitterResult = {
    programId: args.programId,
    configPda: configPda.toBase58(),
    dryRun: args.dryRun,
    sent: false,
    noOp: false,
    txSignature: undefined,
    postSendVerified: false,
    adminAuthority: undefined,
    previousRootSubmitter: undefined,
    proposedRootSubmitter: newKey.toBase58(),
  };

  // Dry-run: fetch config, preview, no send.
  if (args.dryRun) {
    if (!deps) {
      throw new Error(
        "runSetRootSubmitter: deps are required in --dry-run mode"
      );
    }
    const config = await deps.fetchConfig(configPda);
    if (config === null) {
      throw new Error(
        `verifier_config PDA not found at ${configPda.toBase58()}. ` +
          `Run init_devnet.ts first.`
      );
    }
    result.adminAuthority = config.adminAuthority.toBase58();
    result.previousRootSubmitter = config.rootSubmitterAuthority.toBase58();
    if (config.rootSubmitterAuthority.equals(newKey)) {
      result.noOp = true;
    }
    return result;
  }

  // Yes guard.  This must come before any send logic so that calling
  // runSetRootSubmitter directly with dryRun=false, yes=false never reaches
  // the send path regardless of what deps are provided.
  if (!args.yes) {
    throw new Error(
      "runSetRootSubmitter: --yes is required to send the setRootSubmitterAuthority transaction"
    );
  }

  if (!deps) {
    throw new Error("runSetRootSubmitter: deps are required in --yes mode");
  }

  // Fetch config.
  const config = await deps.fetchConfig(configPda);
  if (config === null) {
    throw new Error(
      `verifier_config PDA not found at ${configPda.toBase58()}. ` +
        `Run init_devnet.ts first.`
    );
  }

  result.adminAuthority = config.adminAuthority.toBase58();
  result.previousRootSubmitter = config.rootSubmitterAuthority.toBase58();

  console.log(
    `  admin_authority:          ${config.adminAuthority.toBase58()}`
  );
  console.log(
    `  current root_submitter:   ${config.rootSubmitterAuthority.toBase58()}`
  );
  console.log(`  proposed root_submitter:  ${newKey.toBase58()}`);

  // Admin check: wallet must be admin_authority.
  if (!deps.adminPubkey.equals(config.adminAuthority)) {
    throw new Error(
      `admin_authority mismatch:\n` +
        `  config: ${config.adminAuthority.toBase58()}\n` +
        `  wallet: ${deps.adminPubkey.toBase58()}\n` +
        `The wallet must be admin_authority to call setRootSubmitterAuthority.`
    );
  }

  // No-op check: proposed key already in place.
  if (config.rootSubmitterAuthority.equals(newKey)) {
    result.noOp = true;
    result.postSendVerified = true;
    return result;
  }

  // Send exactly one transaction.
  const txSig = await deps.sendSetRootSubmitter(newKey);
  result.sent = true;
  result.txSignature = txSig;

  // Post-send verification.
  const updated = await deps.refetchConfig(configPda);
  if (updated === null) {
    throw new Error(
      `post-send config fetch failed: verifier_config PDA not found.`
    );
  }
  if (!updated.rootSubmitterAuthority.equals(newKey)) {
    throw new Error(
      `post-send verification failed: root_submitter_authority is ` +
        `${updated.rootSubmitterAuthority.toBase58()} after transaction, ` +
        `expected ${newKey.toBase58()}. ` +
        `Investigate on-chain state before retrying.`
    );
  }
  result.postSendVerified = true;

  return result;
}

// ── Argument parsing ───────────────────────────────────────────────────────────

const VALUED_FLAGS = new Set([
  "--new-root-submitter",
  "--program-id",
  "--commitment",
]);

const BOOL_FLAGS = new Set(["--dry-run", "--yes"]);

export function parseArgs(argv: string[]): SetRootSubmitterArgs {
  let newRootSubmitter: PublicKey | undefined;
  let programId: string = PROGRAM_ID;
  let commitment: "confirmed" | "finalized" | "processed" = "confirmed";
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
        case "--new-root-submitter": {
          let pk: PublicKey;
          try {
            pk = new PublicKey(next);
          } catch {
            throw new Error(
              `parseArgs: --new-root-submitter is not a valid public key: ${next}`
            );
          }
          if (pk.toBase58() === DEFAULT_PUBKEY) {
            throw new Error(
              `parseArgs: --new-root-submitter must not be the default (all-zero) key`
            );
          }
          newRootSubmitter = pk;
          break;
        }
        case "--program-id": {
          try {
            new PublicKey(next);
          } catch {
            throw new Error(
              `parseArgs: --program-id is not a valid public key: ${next}`
            );
          }
          programId = next;
          break;
        }
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
      }
      i++;
    } else {
      throw new Error(`parseArgs: unknown flag: ${flag}`);
    }
  }

  if (dryRun && newRootSubmitter === undefined) {
    throw new Error(
      "parseArgs: --new-root-submitter is required with --dry-run"
    );
  }
  if (yes && newRootSubmitter === undefined) {
    throw new Error("parseArgs: --new-root-submitter is required with --yes");
  }
  if (dryRun && yes) {
    throw new Error("parseArgs: --dry-run and --yes are mutually exclusive");
  }

  return { newRootSubmitter, programId, commitment, dryRun, yes };
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

    const args = (() => {
      try {
        return parseArgs(argv);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    const rpcUrl = process.env.ANCHOR_PROVIDER_URL;

    // No-flag mode: print safety message and exit.  No RPC, no wallet.
    if (!args.dryRun && !args.yes) {
      console.log(`\nNo transaction sent. No RPC connection opened.`);
      console.log(
        `Use --dry-run to preview the proposed rotation (reads config PDA; no wallet required).`
      );
      console.log(`Use --yes only after explicit operator approval.`);
      console.log(
        `\nWith --yes this will send exactly one setRootSubmitterAuthority transaction.`
      );
      console.log(`  ANCHOR_WALLET must be the admin_authority keypair.`);
      console.log(
        `  root_submitter_authority will be set to --new-root-submitter.`
      );
      console.log(
        `  The new root_submitter_authority may call the allowed-root instructions.`
      );
      console.log(
        `  The admin remains the only key that can rotate root_submitter_authority.`
      );
      console.log(`\nRe-run with --dry-run to preview:`);
      console.log(
        `  ANCHOR_PROVIDER_URL=<url> npx ts-node scripts/ops/set_root_submitter_devnet.ts \\`
      );
      console.log(
        `    --new-root-submitter <NEW_ROOT_SUBMITTER_PUBKEY> --dry-run`
      );
      console.log(
        `\nOr with --yes to send (requires ANCHOR_WALLET=admin key):`
      );
      console.log(
        `  ANCHOR_PROVIDER_URL=<url> ANCHOR_WALLET=<ADMIN_KEYPAIR> \\`
      );
      console.log(`  npx ts-node scripts/ops/set_root_submitter_devnet.ts \\`);
      console.log(`    --new-root-submitter <NEW_ROOT_SUBMITTER_PUBKEY> --yes`);
      process.exit(1);
    }

    if (!rpcUrl) {
      console.error("ANCHOR_PROVIDER_URL not set");
      process.exit(1);
    }
    if (rpcUrl.includes("mainnet")) {
      console.error(
        "ANCHOR_PROVIDER_URL appears to point to mainnet. " +
          "This script is for devnet alpha only."
      );
      process.exit(1);
    }

    let configPdaStr = "(unknown — invalid --program-id)";
    try {
      const [configPda] = deriveConfigPda(new PublicKey(args.programId));
      configPdaStr = configPda.toBase58();
    } catch {
      // non-fatal for display
    }

    console.log(`Program ID:              ${args.programId}`);
    console.log(`Config PDA:              ${configPdaStr}`);
    console.log(`Commitment:              ${args.commitment}`);
    console.log(
      `Proposed root submitter: ${args.newRootSubmitter!.toBase58()}`
    );

    const programPubkey = new PublicKey(args.programId);
    const [configPda] = deriveConfigPda(programPubkey);

    let deps: SetRootSubmitterDeps;

    if (args.dryRun) {
      // Dry-run: read-only raw account fetch, no Anchor, no wallet.
      // @solana/web3.js Connection is available via the top-level import.
      const { Connection: SolanaConnection } = require("@solana/web3.js") as {
        Connection: typeof import("@solana/web3.js").Connection;
      };
      const connection = new SolanaConnection(rpcUrl!, args.commitment);

      deps = {
        adminPubkey: new PublicKey(new Uint8Array(32)),
        fetchConfig: async (pda) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const info = await connection.getAccountInfo(
            pda,
            args.commitment as any
          );
          if (!info) return null;
          if (!info.owner.equals(programPubkey)) {
            throw new Error(
              `verifier_config account is not owned by the expected program.\n` +
                `  expected owner: ${programPubkey.toBase58()}\n` +
                `  actual owner:   ${info.owner.toBase58()}`
            );
          }
          const data = Buffer.from(info.data);
          if (data.length !== VERIFIER_CONFIG_SIZE) {
            throw new Error(
              `verifier_config account has unexpected size: ` +
                `expected ${VERIFIER_CONFIG_SIZE} bytes, got ${data.length}`
            );
          }
          const disc = VERIFIER_CONFIG_DISCRIMINATOR;
          for (let bi = 0; bi < 8; bi++) {
            if (data[bi] !== disc[bi]) {
              throw new Error(
                `verifier_config discriminator mismatch at byte ${bi}: ` +
                  `expected ${disc[bi]}, got ${data[bi]}`
              );
            }
          }
          return {
            adminAuthority: new PublicKey(data.slice(8, 40)),
            rootSubmitterAuthority: new PublicKey(data.slice(72, 104)),
          };
        },
        sendSetRootSubmitter: async () => {
          throw new Error(
            "sendSetRootSubmitter must not be called in dry-run mode"
          );
        },
        refetchConfig: async () => {
          throw new Error("refetchConfig must not be called in dry-run mode");
        },
      };
    } else {
      // Yes path: load Anchor and wallet.  readKeypair is called only here.
      // @anchor-lang/core is required only here to avoid loading Anchor when
      // this module is imported in tests.
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

      const connection = new anchor.web3.Connection(rpcUrl!, args.commitment);

      const walletPath = process.env.ANCHOR_WALLET;
      if (!walletPath) {
        console.error("ANCHOR_WALLET not set");
        process.exit(1);
      }

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

      console.log(
        `Admin (wallet):          ${adminKeypair.publicKey.toBase58()}`
      );
      console.log(`\n[!] Sending setRootSubmitterAuthority transaction...`);

      const wallet = new anchor.Wallet(adminKeypair);
      const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: args.commitment,
      });
      anchor.setProvider(provider);
      const program = new anchor.Program(idl, provider);

      deps = {
        adminPubkey: adminKeypair.publicKey,
        fetchConfig: async (pda) => {
          return (await (program.account as any).verifierConfig.fetch(
            pda
          )) as VerifierConfigData;
        },
        sendSetRootSubmitter: async (newRootSubmitter) => {
          return await (program.methods as any)
            .setRootSubmitterAuthority(newRootSubmitter)
            .accounts({
              admin: adminKeypair.publicKey,
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
    }

    try {
      const result = await runSetRootSubmitter(args, deps);

      if (args.dryRun) {
        console.log(`\n[DRY RUN] No transaction sent.`);
        console.log(
          `  admin_authority:          ${
            result.adminAuthority ?? "(not fetched)"
          }`
        );
        console.log(
          `  current_root_submitter:   ${
            result.previousRootSubmitter ?? "(not fetched)"
          }`
        );
        console.log(
          `  proposed_root_submitter:  ${
            result.proposedRootSubmitter ?? "(not set)"
          }`
        );
        console.log(`  commitment:               ${args.commitment}`);
        console.log(`  sent:                     false`);
        if (result.noOp) {
          console.log(
            `\nProposed key is already root_submitter_authority. No rotation needed.`
          );
        } else {
          console.log(
            `\nTo send, re-run with --yes (requires ANCHOR_WALLET=admin key):`
          );
          console.log(
            `  ANCHOR_PROVIDER_URL=<url> ANCHOR_WALLET=<ADMIN_KEYPAIR> \\`
          );
          console.log(
            `  npx ts-node scripts/ops/set_root_submitter_devnet.ts \\`
          );
          console.log(
            `    --new-root-submitter ${args.newRootSubmitter!.toBase58()} --yes`
          );
        }
      } else {
        console.log(`\nResult:`);
        console.log(
          `  admin_authority:          ${result.adminAuthority ?? "(unknown)"}`
        );
        console.log(
          `  previous_root_submitter:  ${
            result.previousRootSubmitter ?? "(unknown)"
          }`
        );
        console.log(
          `  new_root_submitter:       ${
            result.proposedRootSubmitter ?? "(unknown)"
          }`
        );
        console.log(`  sent:                     ${result.sent}`);
        console.log(
          `  tx:                       ${result.txSignature ?? "(none)"}`
        );
        console.log(`  post_send_verified:       ${result.postSendVerified}`);
        if (result.noOp) {
          console.log(
            `\nNo-op: proposed key was already root_submitter_authority.`
          );
        } else if (result.sent && result.postSendVerified) {
          console.log(`\nroot_submitter_authority rotated successfully.`);
          console.log(
            `Root submission now requires the wallet for: ${result.proposedRootSubmitter}`
          );
          console.log(
            `Verify with: npx ts-node scripts/ops/inspect_allowed_roots_devnet.ts ` +
              `--rpc-url ${rpcUrl} --program-id ${args.programId}`
          );
        }
      }
    } catch (err) {
      console.error(`\nerror: ${(err as Error).message}`);
      process.exit(1);
    }
  })();
}
