#!/usr/bin/env ts-node
/**
 * Read-only nullifier state diagnostic.
 *
 * Derives the nullifier marker PDA for a given nullifier hash and reports
 * whether the account exists on-chain, its owner, lamports, and data length.
 *
 * No signing. No keypairs. No transactions. No mutation.
 *
 * A missing marker at the selected RPC endpoint and commitment level does not
 * guarantee the nullifier is unspent or that a future send will succeed.
 * Always run full simulation and diagnostics before any live send.
 *
 * This report is not a privacy guarantee.
 */

import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { deriveWithdrawZkNullifierMarkerPda } from "../../lib/zk_prover/withdraw_zk_artifacts";
import { EXPECTED_NULLIFIER_MARKER_LEN } from "./verify_withdraw_zk_send_devnet";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface NullifierStateArgs {
  rpcUrl: string;
  programId: string;
  nullifierHash: string;
  commitment: "processed" | "confirmed" | "finalized";
  json: boolean;
}

export interface NullifierStateReport {
  mode: "nullifier_state_diagnostic";
  rpcUrl: string;
  programId: string;
  commitment: string;
  nullifierHash: string;
  nullifierPda: string;
  exists: boolean;
  owner: string | null;
  lamports: number | null;
  dataLength: number | null;
  ownerMatchesProgram: boolean | null;
  expectedDataLength: number;
  warnings: string[];
  notes: string[];
}

// ── Re-export for tests ────────────────────────────────────────────────────────

export { deriveWithdrawZkNullifierMarkerPda as deriveNullifierMarkerPda };

// ── Arg parser ─────────────────────────────────────────────────────────────────

const VALUED_FLAGS = new Set([
  "--rpc-url",
  "--program-id",
  "--nullifier-hash",
  "--commitment",
]);
const BOOL_FLAGS = new Set(["--json"]);

export function parseNullifierStateArgs(argv: string[]): NullifierStateArgs {
  let rpcUrl: string | undefined;
  let programId: string | undefined;
  let nullifierHash: string | undefined;
  let commitment: "processed" | "confirmed" | "finalized" = "confirmed";
  let json = false;

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (VALUED_FLAGS.has(flag)) {
      const next = argv[i + 1];
      if (
        next === undefined ||
        VALUED_FLAGS.has(next) ||
        BOOL_FLAGS.has(next)
      ) {
        throw new Error(
          "parseNullifierStateArgs: " +
            flag +
            " requires a value but none was provided"
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
              "parseNullifierStateArgs: --program-id is not a valid public key: " +
                next
            );
          }
          programId = next;
          break;
        case "--nullifier-hash":
          if (!/^[0-9a-fA-F]{64}$/.test(next)) {
            throw new Error(
              "parseNullifierStateArgs: --nullifier-hash must be exactly 64 hex" +
                " characters, got: " +
                JSON.stringify(next)
            );
          }
          nullifierHash = next.toLowerCase();
          break;
        case "--commitment":
          if (
            next !== "processed" &&
            next !== "confirmed" &&
            next !== "finalized"
          ) {
            throw new Error(
              "parseNullifierStateArgs: --commitment must be processed," +
                " confirmed, or finalized; got: " +
                JSON.stringify(next)
            );
          }
          commitment = next;
          break;
      }
      i += 2;
    } else if (BOOL_FLAGS.has(flag)) {
      if (flag === "--json") json = true;
      i++;
    } else {
      throw new Error("parseNullifierStateArgs: unknown flag: " + flag);
    }
  }

  if (rpcUrl === undefined)
    throw new Error("parseNullifierStateArgs: --rpc-url is required");
  if (programId === undefined)
    throw new Error("parseNullifierStateArgs: --program-id is required");
  if (nullifierHash === undefined)
    throw new Error("parseNullifierStateArgs: --nullifier-hash is required");

  return { rpcUrl, programId, nullifierHash, commitment, json };
}

// ── Report builder ─────────────────────────────────────────────────────────────

export function buildNullifierStateReport(
  args: NullifierStateArgs,
  accountInfo: {
    owner: PublicKey;
    data: Buffer | Uint8Array;
    lamports: number;
  } | null
): NullifierStateReport {
  const programIdPk = new PublicKey(args.programId);
  const [markerPk] = deriveWithdrawZkNullifierMarkerPda(
    programIdPk,
    args.nullifierHash
  );
  const nullifierPda = markerPk.toBase58();
  const warnings: string[] = [];

  let exists = false;
  let owner: string | null = null;
  let lamports: number | null = null;
  let dataLength: number | null = null;
  let ownerMatchesProgram: boolean | null = null;

  if (accountInfo !== null) {
    exists = true;
    owner = accountInfo.owner.toBase58();
    lamports = accountInfo.lamports;
    dataLength = accountInfo.data.length;
    ownerMatchesProgram = accountInfo.owner.equals(programIdPk);

    warnings.push(
      "[NULLIFIER_MARKER_EXISTS] Nullifier marker account exists at " +
        nullifierPda +
        ". A withdraw_zk transaction using this nullifier hash should fail" +
        " with NullifierAlreadyUsed."
    );

    if (!ownerMatchesProgram) {
      warnings.push(
        "[NULLIFIER_MARKER_OWNER_MISMATCH] Marker account owner " +
          owner +
          " does not match program ID " +
          args.programId +
          "."
      );
    }

    if (dataLength !== EXPECTED_NULLIFIER_MARKER_LEN) {
      warnings.push(
        "[NULLIFIER_MARKER_UNEXPECTED_DATA_LENGTH] Marker data length is " +
          dataLength +
          ", expected " +
          EXPECTED_NULLIFIER_MARKER_LEN +
          "."
      );
    }
  }

  const notes = [
    "exists: false means the marker was not found at this RPC endpoint" +
      " and commitment level.",
    "exists: false is not a privacy guarantee and does not prove a future" +
      " send will succeed.",
    "Devnet can reset; RPC commitment level affects visibility of recent" +
      " transactions.",
    "Always run full simulation and diagnostics before any live send.",
  ];

  return {
    mode: "nullifier_state_diagnostic",
    rpcUrl: args.rpcUrl,
    programId: args.programId,
    commitment: args.commitment,
    nullifierHash: args.nullifierHash,
    nullifierPda,
    exists,
    owner,
    lamports,
    dataLength,
    ownerMatchesProgram,
    expectedDataLength: EXPECTED_NULLIFIER_MARKER_LEN,
    warnings,
    notes,
  };
}

// ── Human formatter ────────────────────────────────────────────────────────────

function printHumanReport(
  report: NullifierStateReport,
  log: (line: string) => void
): void {
  log("Nullifier state diagnostic");
  log("rpc_url:               " + report.rpcUrl);
  log("program_id:            " + report.programId);
  log("commitment:            " + report.commitment);
  log("nullifier_hash:        " + report.nullifierHash);
  log("nullifier_pda:         " + report.nullifierPda);
  log("exists:                " + report.exists);
  if (report.exists) {
    log("owner:                 " + (report.owner ?? "(null)"));
    log("lamports:              " + (report.lamports ?? "(null)"));
    log("data_length:           " + (report.dataLength ?? "(null)"));
    log("owner_matches_program: " + (report.ownerMatchesProgram ?? "(null)"));
    log("expected_data_length:  " + report.expectedDataLength);
  }
  if (report.warnings.length > 0) {
    log("warnings:");
    for (const w of report.warnings) log("  " + w);
  } else {
    log("warnings: (none)");
  }
  log("notes:");
  for (const n of report.notes) log("  " + n);
}

// ── CLI runner ─────────────────────────────────────────────────────────────────

export async function runInspectNullifierState(
  argv: string[],
  deps?: {
    getAccountInfo?: (pubkey: PublicKey) => Promise<{
      owner: PublicKey;
      data: Buffer | Uint8Array;
      lamports: number;
    } | null>;
    log?: (line: string) => void;
    warn?: (line: string) => void;
  }
): Promise<number> {
  const log = deps?.log ?? ((line: string) => console.log(line));
  const warn = deps?.warn ?? ((line: string) => console.warn(line));

  let args: NullifierStateArgs;
  try {
    args = parseNullifierStateArgs(argv);
  } catch (e) {
    warn((e as Error).message);
    return 1;
  }

  const programIdPk = new PublicKey(args.programId);
  const [markerPk] = deriveWithdrawZkNullifierMarkerPda(
    programIdPk,
    args.nullifierHash
  );

  let accountInfo: {
    owner: PublicKey;
    data: Buffer | Uint8Array;
    lamports: number;
  } | null;
  try {
    if (deps?.getAccountInfo !== undefined) {
      accountInfo = await deps.getAccountInfo(markerPk);
    } else {
      const conn = new Connection(args.rpcUrl, args.commitment as Commitment);
      const info = await conn.getAccountInfo(
        markerPk,
        args.commitment as Commitment
      );
      accountInfo =
        info !== null
          ? {
              owner: info.owner,
              data: info.data as Buffer,
              lamports: info.lamports,
            }
          : null;
    }
  } catch (e) {
    warn("error: " + (e as Error).message);
    return 1;
  }

  const report = buildNullifierStateReport(args, accountInfo);

  if (args.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report, log);
  }

  return 0;
}

// ── Entry point ────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: npx ts-node --project tsconfig.json" +
        " scripts/ops/inspect_nullifier_state_devnet.ts \\\n" +
        "  --rpc-url <url> --program-id <pubkey> --nullifier-hash <64hex> \\\n" +
        "  [--commitment processed|confirmed|finalized] [--json]\n\n" +
        "No signing. No keypairs. No transactions. Read-only RPC only.\n" +
        "A missing marker is not a privacy guarantee and does not prove" +
        " a future send will succeed."
    );
    process.exit(0);
  }

  runInspectNullifierState(argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error((e as Error).message);
      process.exit(1);
    });
}
