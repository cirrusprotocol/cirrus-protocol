#!/usr/bin/env ts-node
/**
 * Phase 4 prover-input export tool.
 *
 * Reads a local indexer snapshot (produced by scripts/zk_indexer_rpc_fetch.ts),
 * selects a note by leaf index or commitment, validates note ownership using the
 * provided secret, and exports witness.json and public.json for use by a Groth16
 * prover (NOT implemented here).
 *
 * This tool does NOT generate or verify Groth16 proofs.
 * This tool does NOT submit roots or send transactions.
 * This tool does NOT open RPC connections or load wallets.
 *
 * WARNING: --secret is for local test/dev use only. Never pass a real note
 * secret on shared shells, CI logs, hosted runners, or multi-user environments.
 * Shell history records command-line arguments.
 *
 * Modes:
 *   --dry-run   Compute and print sanitized summary to stdout. Write no files.
 *   --yes       Write witness.json and public.json. Requires --witness-output
 *               and --public-output.
 *   (neither)   Print usage and exit.
 */

import * as fs from "fs";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import { BN254_FR_MODULUS_HEX } from "../lib/zk_indexer/constants";
import {
  buildWitnessFromSnapshot,
  buildWithdrawSolV1CircomInputJson,
} from "../lib/zk_prover/witness";
import {
  SMALL_SNAPSHOT_LEAF_COUNT_THRESHOLD,
  collectWitnessSnapshotHygieneWarnings,
} from "../lib/zk_hygiene/snapshot";

export {
  SMALL_SNAPSHOT_LEAF_COUNT_THRESHOLD,
  collectWitnessSnapshotHygieneWarnings,
};

const BN254_FR_MODULUS = BigInt("0x" + BN254_FR_MODULUS_HEX);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CliArgs {
  snapshotPath: string;
  leafIndex?: number;
  commitmentHex?: string;
  secret: bigint;
  denomination: bigint;
  fee: bigint;
  chainId: bigint;
  expirySlot: bigint;
  programId: string;
  poolPda: string;
  configPda: string;
  recipient: string;
  relayer: string;
  witnessOutput?: string;
  publicOutput?: string;
  circuitInputOutput?: string;
  dryRun: boolean;
  yes: boolean;
}

export interface CliDeps {
  writeFile?: (path: string, content: string) => void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

// ── Arg parser ────────────────────────────────────────────────────────────────

const USAGE = `
Usage: zk_prover_export_witness.ts [options]

Required:
  --snapshot <path>         Path to local indexer snapshot (v1 or v2 JSON)
  --secret <64-char-hex>    Note secret as 64-char hex BN254 Fr element.
                            Convenient for local tests but can appear in shell
                            history and process args; prefer --secret-file for
                            operator flows.
  --secret-file <path>      Read note secret from file (UTF-8, 64-char hex,
                            whitespace trimmed). Preferred for operator flows:
                            avoids shell history and process arg exposure.
  (exactly one of --secret or --secret-file is required)
  --denomination <n>        Note denomination in lamports
  --fee <n>                 Withdrawal fee in lamports
  --expiry-slot <n>         Intent expiry slot
  --program-id <pubkey>     Shielded pool program ID
  --pool-pda <pubkey>       Pool state PDA address
  --config-pda <pubkey>     Verifier config PDA address
  --recipient <pubkey>      Withdrawal recipient address
  --relayer <pubkey>        Relayer address

Note selector (mutually exclusive, one required):
  --leaf-index <n>          Select note by leaf index (preferred when duplicates exist)
  --commitment <hex>        Select note by commitment (uses first occurrence if duplicates)

Output (mutually exclusive modes):
  --dry-run                 Print summary to stdout; write no files
  --yes                     Write files (requires --witness-output and --public-output)
  --witness-output <path>   Output path for witness.json (required with --yes)
  --public-output <path>    Output path for public.json (required with --yes)

Optional:
  --chain-id <n>            Chain ID (default: 1)
  --circuit-input-output <path>  Write circom-compatible input JSON to <path> (--yes only)
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      flags.add("dry-run");
    } else if (arg === "--yes") {
      flags.add("yes");
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`--${key} requires a value`);
      }
      args[key] = val;
      i++;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  // Required fields
  for (const key of [
    "snapshot",
    "denomination",
    "fee",
    "expiry-slot",
    "program-id",
    "pool-pda",
    "config-pda",
    "recipient",
    "relayer",
  ]) {
    if (args[key] === undefined) throw new Error(`--${key} is required`);
  }

  // Exactly one of --secret or --secret-file must be provided
  const hasSecret = args["secret"] !== undefined;
  const hasSecretFile = args["secret-file"] !== undefined;
  if (hasSecret && hasSecretFile) {
    throw new Error(
      "--secret and --secret-file are mutually exclusive; provide exactly one"
    );
  }
  if (!hasSecret && !hasSecretFile) {
    throw new Error(
      "--secret or --secret-file is required (provide exactly one; --secret-file is preferred for operator flows)"
    );
  }

  // Secret validation — parse to bigint; do not store the hex string
  let secretHex: string;
  if (hasSecretFile) {
    const filePath = args["secret-file"];
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      throw new Error(
        `--secret-file: cannot read file "${filePath}": ${(e as Error).message}`
      );
    }
    secretHex = raw.trim();
    if (secretHex.length === 0) {
      throw new Error(`--secret-file: file is empty: "${filePath}"`);
    }
    if (secretHex.length !== 64) {
      throw new Error(
        `--secret-file: expected 64 hex chars, got ${secretHex.length}: "${filePath}"`
      );
    }
    if (!/^[0-9a-fA-F]+$/.test(secretHex)) {
      throw new Error(`--secret-file: content is not valid hex: "${filePath}"`);
    }
  } else {
    secretHex = args["secret"];
    if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) {
      throw new Error("--secret must be a 64-char hex string");
    }
  }
  const secret = BigInt("0x" + secretHex);
  if (secret >= BN254_FR_MODULUS) {
    throw new Error(
      hasSecretFile
        ? "--secret-file: secret is not a canonical BN254 Fr element"
        : "--secret is not a canonical BN254 Fr element"
    );
  }

  // Selector
  const hasLeafIndex = args["leaf-index"] !== undefined;
  const hasCommitment = args["commitment"] !== undefined;
  if (!hasLeafIndex && !hasCommitment) {
    throw new Error("Provide either --leaf-index or --commitment");
  }
  if (hasLeafIndex && hasCommitment) {
    throw new Error("--leaf-index and --commitment are mutually exclusive");
  }

  const leafIndex = hasLeafIndex ? parseInt(args["leaf-index"], 10) : undefined;
  if (
    leafIndex !== undefined &&
    (!Number.isInteger(leafIndex) || leafIndex < 0)
  ) {
    throw new Error("--leaf-index must be a non-negative integer");
  }

  // Modes
  const dryRun = flags.has("dry-run");
  const yes = flags.has("yes");
  if (dryRun && yes) {
    throw new Error("--dry-run and --yes are mutually exclusive");
  }
  if (!dryRun && yes) {
    if (!args["witness-output"])
      throw new Error("--witness-output is required with --yes");
    if (!args["public-output"])
      throw new Error("--public-output is required with --yes");
  }

  return {
    snapshotPath: args["snapshot"],
    leafIndex,
    commitmentHex: hasCommitment ? args["commitment"] : undefined,
    secret,
    denomination: BigInt(args["denomination"]),
    fee: BigInt(args["fee"]),
    chainId: BigInt(args["chain-id"] ?? "1"),
    expirySlot: BigInt(args["expiry-slot"]),
    programId: args["program-id"],
    poolPda: args["pool-pda"],
    configPda: args["config-pda"],
    recipient: args["recipient"],
    relayer: args["relayer"],
    witnessOutput: args["witness-output"],
    publicOutput: args["public-output"],
    circuitInputOutput: args["circuit-input-output"],
    dryRun,
    yes,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runExportWitness(
  args: CliArgs,
  deps?: CliDeps
): Promise<void> {
  const writeFile =
    deps?.writeFile ??
    ((p: string, content: string) => fs.writeFileSync(p, content, "utf-8"));
  const log = deps?.log ?? console.log.bind(console);
  const warn = deps?.warn ?? console.warn.bind(console);

  if (!args.dryRun && !args.yes) {
    throw new Error(
      "Write mode requires --yes. Use --dry-run to preview without writing files."
    );
  }

  await initPoseidon();

  const selector =
    args.leafIndex !== undefined
      ? { leafIndex: args.leafIndex }
      : { commitmentHex: args.commitmentHex! };

  const { witness, publicInputs, warnings } = buildWitnessFromSnapshot(
    args.snapshotPath,
    selector,
    args.secret,
    {
      programId: args.programId,
      poolPda: args.poolPda,
      configPda: args.configPda,
      recipient: args.recipient,
      relayer: args.relayer,
      denomination: args.denomination,
      fee: args.fee,
      chainId: args.chainId,
      expirySlot: args.expirySlot,
    }
  );

  for (const w of warnings) warn(w);

  // Snapshot hygiene — lightweight JSON parse, no tree replay
  let snapshotLeafCount = 0;
  try {
    const snapRaw = fs.readFileSync(args.snapshotPath, "utf-8");
    const snap = JSON.parse(snapRaw) as { leaf_count?: number };
    if (typeof snap.leaf_count === "number")
      snapshotLeafCount = snap.leaf_count;
  } catch {
    // best-effort; snapshot was already validated by buildWitnessFromSnapshot above
  }
  const hygieneWarnings = collectWitnessSnapshotHygieneWarnings({
    leafIndex: witness.leaf_index,
    leafCount: snapshotLeafCount,
  });
  for (const w of hygieneWarnings) warn(w);

  warn(
    "NOTICE: Witness export does not check whether root_be_hex is currently present " +
      "in the on-chain allowed_roots registry.\n" +
      "Run inspect_allowed_roots_devnet.ts or a future explicit --check-allowed-root " +
      "flow before submitting or proving against a live deployment."
  );

  // Build sanitized summary — secret is NEVER included
  const summary = {
    leaf_index: witness.leaf_index,
    commitment_be_hex: witness.commitment_be_hex,
    root_be_hex: witness.root_be_hex,
    nullifier_hash_be_hex: witness.nullifier_hash_be_hex,
    tx_hash_be_hex: witness.tx_hash_be_hex,
    denomination: witness.denomination,
    fee: witness.fee,
    chain_id: witness.chain_id,
    expiry_slot: witness.expiry_slot,
    path_length: witness.path_elements_be_hex.length,
    public_inputs_order: publicInputs.public_inputs_order,
  };

  if (args.dryRun) {
    log("[dry-run] Witness summary (secret excluded):");
    log(JSON.stringify(summary, null, 2));
    log("[dry-run] public.json:");
    log(JSON.stringify(publicInputs, null, 2));
    return;
  }

  writeFile(args.witnessOutput!, JSON.stringify(witness, null, 2));
  writeFile(args.publicOutput!, JSON.stringify(publicInputs, null, 2));
  log(`Wrote witness to: ${args.witnessOutput}`);
  log(`Wrote public inputs to: ${args.publicOutput}`);

  if (args.circuitInputOutput) {
    const accounts = {
      programId: args.programId,
      poolPda: args.poolPda,
      configPda: args.configPda,
      recipient: args.recipient,
      relayer: args.relayer,
    };
    const circuitInput = buildWithdrawSolV1CircomInputJson(
      witness,
      args.secret,
      accounts
    );
    writeFile(args.circuitInputOutput, JSON.stringify(circuitInput, null, 2));
    log(`Wrote circuit input to: ${args.circuitInputOutput}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    console.error(USAGE);
    process.exit(1);
  }

  runExportWitness(args).catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
}
