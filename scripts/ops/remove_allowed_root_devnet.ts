#!/usr/bin/env ts-node
/**
 * Guarded operator script to remove one allowed root from the on-chain
 * verifier_config PDA via removeAllowedRoot.
 *
 * The on-chain removeAllowedRoot instruction requires the signer to be
 * root_submitter_authority (not admin_authority).  Use --root-submitter-keypair
 * to supply the root-submitter keypair explicitly; ANCHOR_WALLET is not used.
 *
 * Modes:
 *   --dry-run   Open RPC, decode config, confirm root is present.
 *               No keypair loaded.  No transaction sent.
 *   --yes       Load --root-submitter-keypair, verify it matches on-chain
 *               root_submitter_authority, send exactly one removeAllowedRoot
 *               transaction, post-send verify root is gone.
 *   (neither)   Print safety message and exit non-zero.  No RPC connection.
 *
 * --dry-run and --yes are mutually exclusive.
 *
 * Devnet-alpha only.  Do not use against mainnet.
 *
 * WARNING: Removing a root that is still expected by a pending withdrawal test
 * will cause that test to fail with UnknownMerkleRoot.  Confirm no pending
 * withdraw_zk tests depend on the target root before removing it.
 *
 * WARNING: If this removal would leave allowed_roots empty, live withdraw_zk
 * calls will fail closed until a new root is submitted.
 *
 * Usage (dry-run):
 *   npx ts-node --project tsconfig.json scripts/ops/remove_allowed_root_devnet.ts \
 *     --rpc-url https://api.devnet.solana.com \
 *     --program-id <PROGRAM_ID> \
 *     --root <64hex> \
 *     --dry-run
 *
 * Usage (send):
 *   npx ts-node --project tsconfig.json scripts/ops/remove_allowed_root_devnet.ts \
 *     --rpc-url https://api.devnet.solana.com \
 *     --program-id <PROGRAM_ID> \
 *     --root <64hex> \
 *     --root-submitter-keypair <path> \
 *     --confirm "REMOVE ROOT FROM DEVNET" \
 *     --yes
 *
 * Exit codes:
 *   0  dry-run: root found, preflight passed
 *   0  yes: root removed and post-send verified
 *   1  root not found, keypair mismatch, RPC failure, invalid args, or missing confirmation
 */

import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  MAX_ROOTS,
  decodeVerifierConfig,
  deriveConfigPda,
  validateRootHex,
} from "./inspect_allowed_roots_devnet";

// ── Constants ──────────────────────────────────────────────────────────────────

export const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";

export const CONFIRM_PHRASE = "REMOVE ROOT FROM DEVNET";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RemoveAllowedRootArgs {
  rpcUrl: string;
  programId: string;
  root: string;
  dryRun: boolean;
  yes: boolean;
  rootSubmitterKeypairPath?: string;
  confirmPhrase?: string;
  commitment: "confirmed" | "finalized" | "processed";
}

export interface RemoveAllowedRootConfigData {
  rootSubmitterAuthority: PublicKey;
  allowedRoots: Buffer[];
}

export interface RemoveAllowedRootDeps {
  rootSubmitterPubkey: PublicKey;
  fetchConfig: (
    configPda: PublicKey
  ) => Promise<RemoveAllowedRootConfigData | null>;
  sendRemoveAllowedRoot: (root: number[]) => Promise<string>;
  refetchConfig: (
    configPda: PublicKey
  ) => Promise<RemoveAllowedRootConfigData | null>;
}

export interface RemoveAllowedRootResult {
  programId: string;
  configPda: string;
  root: string;
  dryRun: boolean;
  rootFound: boolean;
  currentRootCount: number;
  remainingRootsAfterRemoval: number;
  wouldLeaveEmpty: boolean;
  sent: boolean;
  txSignature?: string;
  postSendVerified: boolean;
}

// ── Argument parsing ───────────────────────────────────────────────────────────

const VALUED_FLAGS = new Set([
  "--rpc-url",
  "--program-id",
  "--root",
  "--commitment",
  "--root-submitter-keypair",
  "--confirm",
]);

const BOOL_FLAGS = new Set(["--dry-run", "--yes"]);

export function parseRemoveAllowedRootArgs(
  argv: string[]
): RemoveAllowedRootArgs {
  let rpcUrl: string | undefined;
  let programId: string | undefined;
  let root: string | undefined;
  let dryRun = false;
  let yes = false;
  let rootSubmitterKeypairPath: string | undefined;
  let confirmPhrase: string | undefined;
  let commitment: "confirmed" | "finalized" | "processed" = "confirmed";

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
          `parseRemoveAllowedRootArgs: ${flag} requires a value but none was provided`
        );
      }
      switch (flag) {
        case "--rpc-url":
          rpcUrl = next;
          break;
        case "--program-id":
          try {
            new PublicKey(next);
          } catch {
            throw new Error(
              `parseRemoveAllowedRootArgs: --program-id is not a valid public key: ${next}`
            );
          }
          programId = next;
          break;
        case "--root":
          validateRootHex(next, "--root");
          root = next.toLowerCase();
          break;
        case "--commitment":
          if (
            next !== "confirmed" &&
            next !== "finalized" &&
            next !== "processed"
          ) {
            throw new Error(
              `parseRemoveAllowedRootArgs: --commitment must be confirmed, finalized, or processed; got: ${next}`
            );
          }
          commitment = next;
          break;
        case "--root-submitter-keypair":
          rootSubmitterKeypairPath = next;
          break;
        case "--confirm":
          confirmPhrase = next;
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
      throw new Error(`parseRemoveAllowedRootArgs: unknown flag: ${flag}`);
    }
  }

  if (rpcUrl === undefined) {
    throw new Error("parseRemoveAllowedRootArgs: --rpc-url is required");
  }
  if (programId === undefined) {
    throw new Error("parseRemoveAllowedRootArgs: --program-id is required");
  }
  if (root === undefined) {
    throw new Error("parseRemoveAllowedRootArgs: --root is required");
  }
  if (dryRun && yes) {
    throw new Error(
      "parseRemoveAllowedRootArgs: --dry-run and --yes are mutually exclusive"
    );
  }
  if (yes) {
    if (!rootSubmitterKeypairPath) {
      throw new Error(
        "parseRemoveAllowedRootArgs: --yes requires --root-submitter-keypair"
      );
    }
    if (confirmPhrase !== CONFIRM_PHRASE) {
      throw new Error(
        `parseRemoveAllowedRootArgs: --yes requires --confirm "${CONFIRM_PHRASE}"; ` +
          `got: ${
            confirmPhrase === undefined
              ? "(not provided)"
              : JSON.stringify(confirmPhrase)
          }`
      );
    }
  }

  return {
    rpcUrl,
    programId,
    root,
    dryRun,
    yes,
    rootSubmitterKeypairPath,
    confirmPhrase,
    commitment,
  };
}

// ── Core runner ────────────────────────────────────────────────────────────────

function rootHexInList(rootHex: string, roots: Buffer[]): boolean {
  return roots.some((r) => r.toString("hex").toLowerCase() === rootHex);
}

/**
 * Removes one allowed root from the on-chain verifier_config, or previews the
 * removal in dry-run mode.
 *
 * deps is required in both --dry-run and --yes modes.
 *
 * Steps (--dry-run):
 *   1. Derive configPda; fetchConfig via deps.
 *   2. Confirm target root is present; compute remaining count.
 *   3. Return result without sending.
 *
 * Steps (--yes):
 *   1-2. Same preflight as dry-run.
 *   3. Verify deps.rootSubmitterPubkey equals config.rootSubmitterAuthority.
 *   4. sendRemoveAllowedRoot — exactly one transaction.
 *   5. refetchConfig — confirm root is no longer present.
 */
export async function runRemoveAllowedRoot(
  args: RemoveAllowedRootArgs,
  deps?: RemoveAllowedRootDeps
): Promise<RemoveAllowedRootResult> {
  if (!deps) {
    throw new Error(
      "runRemoveAllowedRoot: deps are required in dry-run and yes mode"
    );
  }

  let programPubkey: PublicKey;
  try {
    programPubkey = new PublicKey(args.programId);
  } catch {
    throw new Error(
      `runRemoveAllowedRoot: invalid program ID: ${args.programId}`
    );
  }

  const [configPda] = deriveConfigPda(programPubkey);

  const result: RemoveAllowedRootResult = {
    programId: args.programId,
    configPda: configPda.toBase58(),
    root: args.root,
    dryRun: args.dryRun,
    rootFound: false,
    currentRootCount: 0,
    remainingRootsAfterRemoval: 0,
    wouldLeaveEmpty: false,
    sent: false,
    postSendVerified: false,
  };

  const config = await deps.fetchConfig(configPda);
  if (config === null) {
    throw new Error(
      `verifier_config PDA not found at ${configPda.toBase58()}. ` +
        `Run init_devnet.ts first.`
    );
  }

  const rootHexNorm = args.root.toLowerCase();
  const rootFound = rootHexInList(rootHexNorm, config.allowedRoots);

  result.rootFound = rootFound;
  result.currentRootCount = config.allowedRoots.length;

  if (!rootFound) {
    throw new Error(
      `root not found in allowed_roots at ${configPda.toBase58()}:\n` +
        `  target:  ${rootHexNorm}\n` +
        `  current: ${config.allowedRoots.length} root(s) registered\n` +
        `Cannot remove a root that is not in the registry.`
    );
  }

  result.remainingRootsAfterRemoval = config.allowedRoots.length - 1;
  result.wouldLeaveEmpty = result.remainingRootsAfterRemoval === 0;

  // Dry-run exits here — no send.
  if (args.dryRun) {
    return result;
  }

  // Yes guard.  Must appear before any send logic so that calling
  // runRemoveAllowedRoot directly with dryRun=false, yes=false never reaches
  // the send path regardless of what deps are provided.
  if (!args.yes) {
    throw new Error("runRemoveAllowedRoot: --yes is required to remove a root");
  }

  // Verify keypair matches on-chain root_submitter_authority.
  if (!deps.rootSubmitterPubkey.equals(config.rootSubmitterAuthority)) {
    throw new Error(
      `root_submitter_authority mismatch:\n` +
        `  config: ${config.rootSubmitterAuthority.toBase58()}\n` +
        `  wallet: ${deps.rootSubmitterPubkey.toBase58()}\n` +
        `The keypair must be root_submitter_authority to call removeAllowedRoot.`
    );
  }

  const rootBytes = Array.from(Buffer.from(rootHexNorm, "hex")) as number[];

  // Send exactly one transaction.
  const txSig = await deps.sendRemoveAllowedRoot(rootBytes);
  result.sent = true;
  result.txSignature = txSig;

  // Post-send verification.
  const updated = await deps.refetchConfig(configPda);
  if (updated === null) {
    throw new Error(
      `post-send config fetch failed: verifier_config PDA not found.`
    );
  }
  const rootStillPresent = rootHexInList(rootHexNorm, updated.allowedRoots);
  if (rootStillPresent) {
    throw new Error(
      `post-send verification failed: root still present in allowed_roots after ` +
        `transaction. Investigate on-chain state before retrying.`
    );
  }
  result.postSendVerified = true;

  return result;
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

    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(`
remove_allowed_root_devnet.ts — guarded removeAllowedRoot operator script

Devnet-alpha only. Removes one allowed root from the on-chain verifier_config PDA.
Mutation requires --yes with an explicit confirmation phrase.
Keypair is loaded only in --yes mode.

WARNING: Do not remove a root needed by a pending withdrawal test.
WARNING: Removing the last root leaves allowed_roots empty; live withdraw_zk
         will fail closed until a new root is submitted.

Modes:
  --dry-run   Read-only: fetch config, confirm root is present. No keypair. No send.
  --yes       Send one removeAllowedRoot transaction. Requires keypair and confirmation.
  (neither)   Print this safety message and exit non-zero.

Usage (dry-run):
  npx ts-node --project tsconfig.json scripts/ops/remove_allowed_root_devnet.ts \\
    --rpc-url https://api.devnet.solana.com \\
    --program-id <PROGRAM_ID> \\
    --root <64hex> \\
    --dry-run

Usage (send):
  npx ts-node --project tsconfig.json scripts/ops/remove_allowed_root_devnet.ts \\
    --rpc-url https://api.devnet.solana.com \\
    --program-id <PROGRAM_ID> \\
    --root <64hex> \\
    --root-submitter-keypair <path> \\
    --confirm "REMOVE ROOT FROM DEVNET" \\
    --yes

Exit codes:
  0  dry-run: root found, preflight passed
  0  yes: root removed and post-send verified
  1  root not found, keypair mismatch, RPC failure, invalid args, or missing confirmation
`);
      process.exit(0);
    }

    // No-mode guard: checked against raw argv before any parsing so that
    // running the script without --dry-run or --yes never requires --rpc-url,
    // --program-id, or --root and never opens an RPC connection or loads a wallet.
    if (!argv.includes("--dry-run") && !argv.includes("--yes")) {
      console.log(`\nNo transaction sent. No RPC connection opened.`);
      console.log(
        `Use --dry-run to preview (reads config PDA; no keypair required).`
      );
      console.log(`Use --yes only after explicit operator approval.`);
      console.log(
        `\nWith --yes this will send exactly one removeAllowedRoot transaction.`
      );
      console.log(`  The root will be removed from allowed_roots.`);
      console.log(
        `  Do not remove a root needed by a pending withdrawal test.`
      );
      console.log(
        `  Removing the last root leaves allowed_roots empty; withdraw_zk`
      );
      console.log(`  will fail closed until a new root is submitted.`);
      console.log(`\nRe-run with --dry-run to preview:`);
      console.log(`  npx ts-node scripts/ops/remove_allowed_root_devnet.ts \\`);
      console.log(`    --rpc-url <url> --program-id <PROGRAM_ID> \\`);
      console.log(`    --root <64hex> --dry-run`);
      process.exit(1);
    }

    const args = (() => {
      try {
        return parseRemoveAllowedRootArgs(argv);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    if (args.rpcUrl.includes("mainnet")) {
      console.error(
        "error: --rpc-url appears to point to mainnet. " +
          "This script is for devnet alpha only."
      );
      process.exit(1);
    }

    let configPdaStr = "(unknown — invalid --program-id)";
    try {
      const [configPda] = deriveConfigPda(new PublicKey(args.programId));
      configPdaStr = configPda.toBase58();
    } catch {
      // non-fatal for display; runner will throw if needed
    }

    console.log(`Program ID:    ${args.programId}`);
    console.log(`Config PDA:    ${configPdaStr}`);
    console.log(`Root:          ${args.root}`);
    console.log(`Commitment:    ${args.commitment}`);

    const programPubkey = new PublicKey(args.programId);
    const [configPda] = deriveConfigPda(programPubkey);

    if (args.dryRun) {
      // Dry-run: read-only raw account fetch via web3.js Connection.
      // No Anchor workspace, no wallet loaded.
      const { Connection: SolanaConnection } = require("@solana/web3.js") as {
        Connection: typeof import("@solana/web3.js").Connection;
      };
      const connection = new SolanaConnection(args.rpcUrl, args.commitment);

      const deps: RemoveAllowedRootDeps = {
        rootSubmitterPubkey: new PublicKey(new Uint8Array(32)),
        fetchConfig: async (pda) => {
          const info = await connection.getAccountInfo(
            pda,
            args.commitment as any
          );
          if (!info) return null;
          const decoded = decodeVerifierConfig(info.data as Buffer);
          if (!decoded) {
            throw new Error(
              `Failed to decode verifier_config at ${pda.toBase58()} ` +
                `(size=${info.data.length}). Verify program ID is correct.`
            );
          }
          return {
            rootSubmitterAuthority: decoded.rootSubmitterAuthority,
            allowedRoots: decoded.allowedRoots,
          };
        },
        sendRemoveAllowedRoot: async () => {
          throw new Error(
            "sendRemoveAllowedRoot must not be called in dry-run mode"
          );
        },
        refetchConfig: async () => {
          throw new Error("refetchConfig must not be called in dry-run mode");
        },
      };

      let result: RemoveAllowedRootResult;
      try {
        result = await runRemoveAllowedRoot(args, deps);
      } catch (err) {
        console.error(`\nerror: ${(err as Error).message}`);
        process.exit(1);
      }

      console.log(`\n[DRY RUN] No transaction sent.`);
      console.log(`  root_found:               ${result.rootFound}`);
      console.log(
        `  current_root_count:       ${result.currentRootCount} / ${MAX_ROOTS}`
      );
      console.log(
        `  remaining_after_removal:  ${result.remainingRootsAfterRemoval}`
      );
      console.warn(
        `\n[WARN] Do not remove a root needed by a pending withdraw_zk test.`
      );
      console.warn(
        `  Verify snapshot/root provenance and confirm no pending test depends on`
      );
      console.warn(`  this root before sending.`);
      if (result.wouldLeaveEmpty) {
        console.warn(
          `\n[WARN] Removing this root would leave allowed_roots empty.`
        );
        console.warn(
          `  Live withdraw_zk will fail closed until a new root is submitted.`
        );
        console.warn(`  Do not remove unless this is intentional.`);
      }
      console.log(`\nTo send, re-run with --yes:`);
      console.log(`  npx ts-node scripts/ops/remove_allowed_root_devnet.ts \\`);
      console.log(`    --rpc-url ${args.rpcUrl} \\`);
      console.log(`    --program-id ${args.programId} \\`);
      console.log(`    --root ${args.root} \\`);
      console.log(`    --root-submitter-keypair <path> \\`);
      console.log(`    --confirm "${CONFIRM_PHRASE}" \\`);
      console.log(`    --yes`);
      return;
    }

    // Yes path: load Anchor and root-submitter keypair.
    // @anchor-lang/core is required lazily to avoid loading Anchor workspace
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

    const rootSubmitterKeypair = (() => {
      try {
        return readKeypair(args.rootSubmitterKeypairPath!);
      } catch (err) {
        console.error(
          `Cannot read root-submitter keypair at ${args.rootSubmitterKeypairPath}: ` +
            `${(err as Error).message}`
        );
        return process.exit(1);
      }
    })();

    console.log(
      `Root submitter (keypair): ${rootSubmitterKeypair.publicKey.toBase58()}`
    );
    console.log(`\n[!] Running guarded removeAllowedRoot flow...`);

    const connection = new anchor.web3.Connection(args.rpcUrl, args.commitment);
    const wallet = new anchor.Wallet(rootSubmitterKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: args.commitment,
    });
    anchor.setProvider(provider);
    const program = new anchor.Program(idl, provider);

    const deps: RemoveAllowedRootDeps = {
      rootSubmitterPubkey: rootSubmitterKeypair.publicKey,
      fetchConfig: async (pda) => {
        const raw = await (program.account as any).verifierConfig.fetch(pda);
        return {
          rootSubmitterAuthority: raw.rootSubmitterAuthority as PublicKey,
          allowedRoots: (raw.allowedRoots as any[]).map((r: any) =>
            Buffer.from(r)
          ),
        };
      },
      sendRemoveAllowedRoot: async (root) => {
        return await (program.methods as any)
          .removeAllowedRoot(root)
          .accounts({
            rootSubmitter: rootSubmitterKeypair.publicKey,
            config: configPda,
          })
          .rpc();
      },
      refetchConfig: async (pda) => {
        const raw = await (program.account as any).verifierConfig.fetch(pda);
        return {
          rootSubmitterAuthority: raw.rootSubmitterAuthority as PublicKey,
          allowedRoots: (raw.allowedRoots as any[]).map((r: any) =>
            Buffer.from(r)
          ),
        };
      },
    };

    try {
      const result = await runRemoveAllowedRoot(args, deps);
      if (result.wouldLeaveEmpty) {
        console.warn(
          `\n[WARN] allowed_roots is now empty. Live withdraw_zk will fail closed`
        );
        console.warn(
          `  until a new root is submitted via submit_root_devnet.ts.`
        );
      }
      console.log(`\nResult:`);
      console.log(`  root:               ${result.root}`);
      console.log(`  sent:               ${result.sent}`);
      console.log(`  tx:                 ${result.txSignature ?? "(none)"}`);
      console.log(`  post_send_verified: ${result.postSendVerified}`);
      if (result.sent && result.postSendVerified) {
        console.log(`\nRoot successfully removed from allowed_roots.`);
        console.log(
          `Verify with: npx ts-node scripts/ops/inspect_allowed_roots_devnet.ts ` +
            `--rpc-url ${args.rpcUrl} --program-id ${args.programId}`
        );
      }
    } catch (err) {
      console.error(`\nerror: ${(err as Error).message}`);
      process.exit(1);
    }
  })();
}
