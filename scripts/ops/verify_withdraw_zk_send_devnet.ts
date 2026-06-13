#!/usr/bin/env ts-node
/**
 * Read-only post-send verifier for withdraw_zk transactions.
 *
 * Reads a send_result.json produced by withdraw_zk_devnet.ts --send --json,
 * confirms the transaction status on-chain, verifies the nullifier marker PDA,
 * and reads current balances. Does not rebroadcast, retry, or modify on-chain state.
 *
 * This helper is not a privacy guarantee and not a production audit.
 */

import * as fs from "fs";
import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import {
  deriveWithdrawZkNullifierMarkerPda,
  deriveWithdrawZkPoolStatePda,
} from "../../lib/zk_prover/withdraw_zk_artifacts";

// NullifierMarker::LEN = DISCRIMINATOR_SIZE (8) + used: bool (1)
export const EXPECTED_NULLIFIER_MARKER_LEN = 9;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VerifyWithdrawZkArgs {
  rpc: string;
  programId?: string;
  sendResultJson: string;
  commitment: string;
  json: boolean;
  checkRegressionNullifier?: string;
}

export interface VerifyWithdrawZkResult {
  ok: boolean;
  mode: "verify";
  rpc: string;
  programId: string;
  signature: string;
  signatureFound: boolean;
  confirmationStatus: string | null;
  transactionError: unknown;
  nullifierMarker: string;
  nullifierMarkerDerived: string;
  nullifierMarkerMatches: boolean;
  nullifierAccountExists: boolean;
  nullifierAccountOwner: string | null;
  nullifierAccountOwnerMatches: boolean;
  nullifierAccountDataLength: number | null;
  nullifierAccountLengthMatches: boolean;
  recipientLamports: string | null;
  relayerLamports: string | null;
  poolLamports: string | null;
  preSendPoolLamportsFromSendResult: string | null;
  regressionNullifierChecked: boolean;
  regressionNullifierPda: string | null;
  regressionNullifierExists: boolean | null;
  warnings: string[];
}

export interface VerifyWithdrawZkConnection {
  getSignatureStatus(
    sig: string
  ): Promise<{ confirmationStatus?: string | null; err?: unknown } | null>;
  getAccountInfo(pubkey: PublicKey): Promise<{
    owner: PublicKey;
    data: Buffer | Uint8Array;
    lamports: number;
  } | null>;
}

export interface VerifyWithdrawZkDeps {
  readFileSync: (p: string) => string;
  connection: VerifyWithdrawZkConnection;
}

// ── Arg parser ────────────────────────────────────────────────────────────────

export function parseVerifyArgs(argv: string[]): VerifyWithdrawZkArgs {
  const out: Partial<VerifyWithdrawZkArgs> & {
    commitment: string;
    json: boolean;
  } = { commitment: "confirmed", json: false };

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--rpc":
        if (!next || next.startsWith("--"))
          throw new Error("parseVerifyArgs: --rpc requires a value");
        out.rpc = next;
        i += 2;
        break;
      case "--program-id":
        if (!next || next.startsWith("--"))
          throw new Error("parseVerifyArgs: --program-id requires a value");
        out.programId = next;
        i += 2;
        break;
      case "--send-result-json":
        if (!next || next.startsWith("--"))
          throw new Error(
            "parseVerifyArgs: --send-result-json requires a value"
          );
        out.sendResultJson = next;
        i += 2;
        break;
      case "--commitment":
        if (!next || next.startsWith("--"))
          throw new Error("parseVerifyArgs: --commitment requires a value");
        if (next !== "confirmed" && next !== "finalized")
          throw new Error(
            `parseVerifyArgs: --commitment must be "confirmed" or "finalized", got ${JSON.stringify(
              next
            )}`
          );
        out.commitment = next;
        i += 2;
        break;
      case "--check-regression-nullifier":
        if (!next || next.startsWith("--"))
          throw new Error(
            "parseVerifyArgs: --check-regression-nullifier requires a value"
          );
        out.checkRegressionNullifier = next;
        i += 2;
        break;
      case "--json":
        out.json = true;
        i++;
        break;
      default:
        throw new Error(`parseVerifyArgs: unknown flag: ${flag}`);
    }
  }

  if (!out.rpc) throw new Error("parseVerifyArgs: --rpc is required");
  if (!out.sendResultJson)
    throw new Error("parseVerifyArgs: --send-result-json is required");
  if (out.rpc.toLowerCase().includes("mainnet"))
    throw new Error(
      "parseVerifyArgs: --rpc mainnet URLs are not allowed; this script is for devnet/alpha only"
    );

  return out as VerifyWithdrawZkArgs;
}

// ── Core runner ───────────────────────────────────────────────────────────────

export async function runVerifyWithdrawZkSend(
  args: VerifyWithdrawZkArgs,
  deps: VerifyWithdrawZkDeps
): Promise<{ result: VerifyWithdrawZkResult; exitCode: number }> {
  // 1. Read and parse send_result.json
  let raw: string;
  try {
    raw = deps.readFileSync(args.sendResultJson);
  } catch (e) {
    throw new Error(
      `cannot read --send-result-json at "${args.sendResultJson}": ${
        (e as Error).message
      }`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `malformed JSON in --send-result-json "${args.sendResultJson}": ${
        (e as Error).message
      }`
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`send_result.json: expected a JSON object`);
  }

  const sr = parsed as Record<string, unknown>;

  if (sr["mode"] !== "send") {
    throw new Error(
      `send_result.json: expected mode "send", got ${JSON.stringify(
        sr["mode"]
      )}`
    );
  }

  const requiredStringFields = [
    "signature",
    "programId",
    "nullifierHash",
    "nullifierMarker",
    "recipient",
    "relayer",
    "denomination",
    "fee",
    "recipientGets",
    "root",
    "txHash",
  ];
  for (const key of requiredStringFields) {
    if (typeof sr[key] !== "string" || (sr[key] as string).length === 0) {
      throw new Error(
        `send_result.json: missing or empty required field "${key}"`
      );
    }
  }

  const signature = sr["signature"] as string;
  const programIdStr = (args.programId ?? sr["programId"]) as string;
  const nullifierHash = sr["nullifierHash"] as string;
  const nullifierMarkerFromResult = sr["nullifierMarker"] as string;
  const recipient = sr["recipient"] as string;
  const relayer = sr["relayer"] as string;
  const preSendPoolLamports =
    typeof sr["poolLamports"] === "string"
      ? (sr["poolLamports"] as string)
      : null;

  if (!/^[0-9a-fA-F]{64}$/.test(nullifierHash)) {
    throw new Error(
      `send_result.json: nullifierHash must be exactly 64 hex chars`
    );
  }

  let programIdPk: PublicKey;
  try {
    programIdPk = new PublicKey(programIdStr);
  } catch {
    throw new Error(`invalid programId: ${JSON.stringify(programIdStr)}`);
  }

  let recipientPk: PublicKey;
  try {
    recipientPk = new PublicKey(recipient);
  } catch {
    throw new Error(
      `send_result.json: invalid recipient pubkey: ${JSON.stringify(recipient)}`
    );
  }

  let relayerPk: PublicKey;
  try {
    relayerPk = new PublicKey(relayer);
  } catch {
    throw new Error(
      `send_result.json: invalid relayer pubkey: ${JSON.stringify(relayer)}`
    );
  }

  // 2. Derive nullifier marker PDA and compare to send result
  const [derivedMarkerPk] = deriveWithdrawZkNullifierMarkerPda(
    programIdPk,
    nullifierHash
  );
  const nullifierMarkerDerived = derivedMarkerPk.toBase58();
  const nullifierMarkerMatches =
    nullifierMarkerDerived === nullifierMarkerFromResult;

  // 3. Signature status (read-only; does not retry or rebroadcast)
  const warnings: string[] = [];
  let signatureFound = false;
  let confirmationStatus: string | null = null;
  let transactionError: unknown = null;

  const sigStatus = await deps.connection.getSignatureStatus(signature);
  if (sigStatus !== null) {
    signatureFound = true;
    confirmationStatus = sigStatus.confirmationStatus ?? null;
    transactionError = sigStatus.err != null ? sigStatus.err : null;
  }

  // 4. Nullifier marker account
  let nullifierAccountExists = false;
  let nullifierAccountOwner: string | null = null;
  let nullifierAccountOwnerMatches = false;
  let nullifierAccountDataLength: number | null = null;
  let nullifierAccountLengthMatches = false;

  const markerInfo = await deps.connection.getAccountInfo(derivedMarkerPk);
  if (markerInfo !== null) {
    nullifierAccountExists = true;
    nullifierAccountOwner = markerInfo.owner.toBase58();
    nullifierAccountOwnerMatches =
      nullifierAccountOwner === programIdPk.toBase58();
    nullifierAccountDataLength = markerInfo.data.length;
    nullifierAccountLengthMatches =
      nullifierAccountDataLength === EXPECTED_NULLIFIER_MARKER_LEN;
  }

  // 5. Current balances (read-only; null means account not found)
  const [poolStatePk] = deriveWithdrawZkPoolStatePda(programIdPk);

  let recipientLamports: string | null = null;
  let relayerLamports: string | null = null;
  let poolLamports: string | null = null;

  const recipientInfo = await deps.connection.getAccountInfo(recipientPk);
  if (recipientInfo !== null)
    recipientLamports = recipientInfo.lamports.toString();

  const relayerInfo = await deps.connection.getAccountInfo(relayerPk);
  if (relayerInfo !== null) relayerLamports = relayerInfo.lamports.toString();

  const poolInfo = await deps.connection.getAccountInfo(poolStatePk);
  if (poolInfo !== null) poolLamports = poolInfo.lamports.toString();

  // 6. Optional regression nullifier check
  let regressionNullifierChecked = false;
  let regressionNullifierPda: string | null = null;
  let regressionNullifierExists: boolean | null = null;

  if (args.checkRegressionNullifier !== undefined) {
    const regHash = args.checkRegressionNullifier;
    if (!/^[0-9a-fA-F]{64}$/.test(regHash)) {
      throw new Error(
        `--check-regression-nullifier: must be exactly 64 hex chars, got ${JSON.stringify(
          regHash
        )}`
      );
    }
    const [regPk] = deriveWithdrawZkNullifierMarkerPda(programIdPk, regHash);
    regressionNullifierPda = regPk.toBase58();
    regressionNullifierChecked = true;
    const regInfo = await deps.connection.getAccountInfo(regPk);
    regressionNullifierExists = regInfo !== null;
    if (regressionNullifierExists) {
      warnings.push(
        "[REGRESSION_NULLIFIER_EXISTS] Regression nullifier marker account exists at " +
          regressionNullifierPda +
          ". Verify this note was not spent by the current withdrawal."
      );
    }
  }

  // 7. Overall result
  const ok =
    signatureFound &&
    transactionError == null &&
    nullifierMarkerMatches &&
    nullifierAccountExists &&
    nullifierAccountOwnerMatches &&
    nullifierAccountLengthMatches;

  const result: VerifyWithdrawZkResult = {
    ok,
    mode: "verify",
    rpc: args.rpc,
    programId: programIdStr,
    signature,
    signatureFound,
    confirmationStatus,
    transactionError,
    nullifierMarker: nullifierMarkerFromResult,
    nullifierMarkerDerived,
    nullifierMarkerMatches,
    nullifierAccountExists,
    nullifierAccountOwner,
    nullifierAccountOwnerMatches,
    nullifierAccountDataLength,
    nullifierAccountLengthMatches,
    recipientLamports,
    relayerLamports,
    poolLamports,
    preSendPoolLamportsFromSendResult: preSendPoolLamports,
    regressionNullifierChecked,
    regressionNullifierPda,
    regressionNullifierExists,
    warnings,
  };

  return { result, exitCode: ok ? 0 : 1 };
}

// ── Output ────────────────────────────────────────────────────────────────────

function printResult(
  result: VerifyWithdrawZkResult,
  jsonMode: boolean,
  stdout: (line: string) => void
): void {
  if (jsonMode) {
    stdout(JSON.stringify(result, null, 2));
    return;
  }
  stdout("=== withdraw_zk post-send verification ===");
  stdout(`ok:                         ${result.ok}`);
  stdout(`rpc:                        ${result.rpc}`);
  stdout(`programId:                  ${result.programId}`);
  stdout(`signature:                  ${result.signature}`);
  stdout(`signatureFound:             ${result.signatureFound}`);
  stdout(
    `confirmationStatus:         ${result.confirmationStatus ?? "(none)"}`
  );
  stdout(
    `transactionError:           ${
      result.transactionError == null
        ? "none"
        : JSON.stringify(result.transactionError)
    }`
  );
  stdout(`nullifierMarker:            ${result.nullifierMarker}`);
  stdout(`nullifierMarkerDerived:     ${result.nullifierMarkerDerived}`);
  stdout(`nullifierMarkerMatches:     ${result.nullifierMarkerMatches}`);
  stdout(`nullifierAccountExists:     ${result.nullifierAccountExists}`);
  stdout(`nullifierOwnerMatches:      ${result.nullifierAccountOwnerMatches}`);
  stdout(
    `nullifierDataLength:        ${
      result.nullifierAccountDataLength ?? "(absent)"
    }`
  );
  stdout(`nullifierLengthMatches:     ${result.nullifierAccountLengthMatches}`);
  if (result.recipientLamports !== null)
    stdout(`recipientLamports:          ${result.recipientLamports}`);
  if (result.relayerLamports !== null)
    stdout(`relayerLamports:            ${result.relayerLamports}`);
  if (result.poolLamports !== null)
    stdout(`poolLamports:               ${result.poolLamports}`);
  if (result.preSendPoolLamportsFromSendResult !== null)
    stdout(
      `preSendPoolLamports:        ${result.preSendPoolLamportsFromSendResult} (from send result)`
    );
  if (result.regressionNullifierChecked) {
    stdout(`regressionNullifierPda:     ${result.regressionNullifierPda}`);
    stdout(`regressionNullifierExists:  ${result.regressionNullifierExists}`);
  }
  if (result.warnings.length > 0) {
    stdout("warnings:");
    for (const w of result.warnings) stdout(`  ${w}`);
  }
  stdout("==========================================");
}

// ── Real connection adapter ───────────────────────────────────────────────────

export function createVerifyConnection(
  rpc: string,
  commitment: string
): VerifyWithdrawZkConnection {
  const commitmentLevel = commitment as Commitment;
  const conn = new Connection(rpc, commitmentLevel);
  return {
    async getSignatureStatus(sig) {
      const res = await conn.getSignatureStatuses([sig], {
        searchTransactionHistory: true,
      });
      const status = res.value[0];
      if (status === null || status === undefined) return null;
      return { confirmationStatus: status.confirmationStatus, err: status.err };
    },
    async getAccountInfo(pubkey) {
      const info = await conn.getAccountInfo(pubkey, commitmentLevel);
      if (!info) return null;
      return {
        owner: info.owner,
        data: info.data as Buffer,
        lamports: info.lamports,
      };
    },
  };
}

// ── CLI runner ────────────────────────────────────────────────────────────────

export async function runVerifyWithdrawZkSendCli(
  argv: string[],
  deps?: {
    readFileSync?: (p: string) => string;
    connection?: VerifyWithdrawZkConnection;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  }
): Promise<number> {
  const stdout = deps?.stdout ?? ((line: string) => console.log(line));
  const stderr = deps?.stderr ?? ((line: string) => console.error(line));

  let args: VerifyWithdrawZkArgs;
  try {
    args = parseVerifyArgs(argv);
  } catch (e) {
    stderr((e as Error).message);
    return 1;
  }

  const rfSync =
    deps?.readFileSync ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const connection =
    deps?.connection ?? createVerifyConnection(args.rpc, args.commitment);

  let result: VerifyWithdrawZkResult;
  let exitCode: number;
  try {
    ({ result, exitCode } = await runVerifyWithdrawZkSend(args, {
      readFileSync: rfSync,
      connection,
    }));
  } catch (e) {
    stderr(`error: ${(e as Error).message}`);
    return 1;
  }

  printResult(result, args.json, stdout);
  return exitCode;
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (require.main === module) {
  runVerifyWithdrawZkSendCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((e) => {
      console.error((e as Error).message);
      process.exit(1);
    });
}
