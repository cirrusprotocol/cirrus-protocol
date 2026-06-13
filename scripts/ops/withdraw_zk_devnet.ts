#!/usr/bin/env ts-node
// Guarded withdraw_zk ops script.
// Simulation mode (--simulate): read-only RPC dry-run, no signing, no send.
// Send mode (--send): full guarded live send with mandatory pre-flight simulation.
// Default behavior (no mode flag) is static dry-run — no RPC, no network.

import * as fs from "fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { ZkProofJson } from "../../lib/zk_prover/fixture";
import {
  decimalStringToBigIntStrict,
  encodeSnarkjsGroth16Proof,
} from "../../lib/zk_prover/proof_encoder";
import {
  detectWithdrawZkRawArtifactPathWarnings,
  deriveWithdrawZkNullifierMarkerPda,
  deriveWithdrawZkPoolStatePda,
  deriveWithdrawZkVerifierConfigPda,
  normalizeHexOrDecimalToHex32,
  parseWithdrawZkInputScalars,
  parseWithdrawZkPublicInputs,
  validateWithdrawZkScalarsAgainstPublicInputs,
} from "../../lib/zk_prover/withdraw_zk_artifacts";
import {
  buildWithdrawZkInstruction,
  buildWithdrawZkInstructionData,
} from "../../lib/zk_prover/withdraw_zk_instruction";

// ── Interfaces ─────────────────────────────────────────────────────────────────

export interface WithdrawZkDryRunArgs {
  programId: string;
  relayer: string;
  recipient: string;
  proofJson: string;
  publicJson: string;
  inputJson: string;
  denomination: string;
  fee: string;
  expirySlot: string;
  circuitVersion: string;
  repoRoot?: string;
  allowInRepoArtifacts?: boolean;
  json?: boolean;
  simulate?: boolean;
  rpc?: string;
  computeUnitLimit?: number;
  // Send mode
  send?: boolean;
  expectedRoot?: string;
  relayerKeypair?: string;
  confirmPhrase?: string;
  // Hygiene
  knownOperators?: string[];
}

export interface WithdrawZkDryRunSummary {
  programId: string;
  relayer: string;
  recipient: string;
  poolState: string;
  config: string;
  nullifierMarker: string;
  rootBeHex: string;
  nullifierHashBeHex: string;
  txHashBeHex: string;
  instructionDataLength: number;
  keyCount: number;
  warnings: string[];
}

export interface WithdrawZkSimulationBlockhash {
  blockhash: string;
  lastValidBlockHeight?: number;
}

export interface WithdrawZkSimulationConnection {
  getLatestBlockhash(): Promise<WithdrawZkSimulationBlockhash>;
  simulateTransaction(tx: Transaction): Promise<{
    value: {
      err: unknown;
      logs?: string[] | null;
      unitsConsumed?: number;
    };
  }>;
}

export interface WithdrawZkSendConnection {
  // Shared with simulation
  getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  simulateTransaction(tx: Transaction): Promise<{
    value: { err: unknown; logs?: string[] | null; unitsConsumed?: number };
  }>;
  // Send guards
  getSlot(): Promise<number>;
  getNullifierMarkerExists(pubkey: PublicKey): Promise<boolean>;
  getPoolRawLamports(pubkey: PublicKey): Promise<bigint>;
  getConfigAllowedRoots(configPda: PublicKey): Promise<string[]>;
  // Broadcast and confirmation
  sendRawTransaction(
    rawTransaction: Buffer,
    opts: { skipPreflight: boolean }
  ): Promise<string>;
  confirmTransaction(
    opts: {
      signature: string;
      blockhash: string;
      lastValidBlockHeight: number;
    },
    commitment: "confirmed"
  ): Promise<{ value: { err: unknown } }>;
}

export interface WithdrawZkSimulationSummary extends WithdrawZkDryRunSummary {
  simulate: true;
  rpc?: string;
  computeUnitLimit: number;
  recentBlockhash: string;
  lastValidBlockHeight?: number;
  simulationOk: boolean;
  simulationError: unknown;
  unitsConsumed?: number;
  logs: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT = 200_000;
export const MAX_WITHDRAW_ZK_SIMULATE_CU_LIMIT = 1_400_000;
export const MIN_SEND_EXPIRY_BUFFER = 300;

const STANDARD_DENOMINATION_BUCKETS = new Set<bigint>([
  1_000_000_000n, // 1 SOL — currently documented and tested withdrawal denomination
]);

// ── Argument parsing ──────────────────────────────────────────────────────────

const REQUIRED_VALUE_FLAGS: Array<[string, keyof WithdrawZkDryRunArgs]> = [
  ["--program-id", "programId"],
  ["--relayer", "relayer"],
  ["--recipient", "recipient"],
  ["--proof-json", "proofJson"],
  ["--public-json", "publicJson"],
  ["--input-json", "inputJson"],
  ["--denomination", "denomination"],
  ["--fee", "fee"],
  ["--expiry-slot", "expirySlot"],
  ["--circuit-version", "circuitVersion"],
];

const OPTIONAL_VALUE_FLAGS: Array<[string, keyof WithdrawZkDryRunArgs]> = [
  ["--repo-root", "repoRoot"],
  ["--rpc", "rpc"],
  ["--expected-root", "expectedRoot"],
  ["--relayer-keypair", "relayerKeypair"],
  ["--confirm", "confirmPhrase"],
];

const BOOLEAN_FLAGS: Array<[string, keyof WithdrawZkDryRunArgs]> = [
  ["--allow-in-repo-artifacts", "allowInRepoArtifacts"],
  ["--json", "json"],
  ["--simulate", "simulate"],
  ["--send", "send"],
];

function parseComputeUnitLimit(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(
      `parseWithdrawZkDryRunArgs: --compute-unit-limit must be a decimal integer, got ${JSON.stringify(
        value
      )}`
    );
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `parseWithdrawZkDryRunArgs: --compute-unit-limit must be >= 1, got ${value}`
    );
  }
  if (n > MAX_WITHDRAW_ZK_SIMULATE_CU_LIMIT) {
    throw new Error(
      `parseWithdrawZkDryRunArgs: --compute-unit-limit must be <= ${MAX_WITHDRAW_ZK_SIMULATE_CU_LIMIT}, got ${value}`
    );
  }
  return n;
}

function rejectMainnetRpc(rpc: string): void {
  const lower = rpc.toLowerCase();
  if (lower.includes("mainnet")) {
    throw new Error(
      `parseWithdrawZkDryRunArgs: --rpc mainnet URLs are not allowed, got ${JSON.stringify(
        rpc
      )}`
    );
  }
}

const SEND_DEVNET_RPCS = new Set([
  "devnet",
  "d",
  "https://api.devnet.solana.com",
]);

function requireDevnetSendRpc(rpc: string): void {
  if (!SEND_DEVNET_RPCS.has(rpc)) {
    throw new Error(
      `parseWithdrawZkDryRunArgs: --send only allows devnet RPC ("devnet", "d", or "https://api.devnet.solana.com"), got ${JSON.stringify(
        rpc
      )}`
    );
  }
}

export function parseWithdrawZkDryRunArgs(
  argv: string[]
): WithdrawZkDryRunArgs {
  const out: Partial<WithdrawZkDryRunArgs> = {};

  const allValueFlags = new Map<string, keyof WithdrawZkDryRunArgs>([
    ...REQUIRED_VALUE_FLAGS,
    ...OPTIONAL_VALUE_FLAGS,
  ]);
  const boolFlags = new Map<string, keyof WithdrawZkDryRunArgs>(BOOLEAN_FLAGS);

  let rawComputeUnitLimit: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (flag === "--help") {
      throw new Error(
        "--help: required: --program-id --relayer --recipient --proof-json --public-json " +
          "--input-json --denomination --fee --expiry-slot --circuit-version; " +
          "optional: --repo-root --allow-in-repo-artifacts --json --expected-root; " +
          "hygiene: --known-operator <PUBKEY> (repeatable; non-blocking warning if recipient or relayer matches; does not read keypair files; not a privacy guarantee); " +
          "simulation: --simulate --rpc <url> --compute-unit-limit <n> (default 200000, also accepted for --send); " +
          "send: --send --rpc <devnet|d|https://api.devnet.solana.com> --expected-root <64hex> " +
          "--relayer-keypair <path> --compute-unit-limit <n> " +
          '--confirm "SEND WITHDRAW_ZK TO DEVNET"'
      );
    }
    if (boolFlags.has(flag)) {
      (out as Record<string, unknown>)[boolFlags.get(flag)!] = true;
      i++;
      continue;
    }
    if (flag === "--compute-unit-limit") {
      if (i + 1 >= argv.length) {
        throw new Error(
          "parseWithdrawZkDryRunArgs: --compute-unit-limit requires a value"
        );
      }
      rawComputeUnitLimit = argv[i + 1];
      i += 2;
      continue;
    }
    if (allValueFlags.has(flag)) {
      const key = allValueFlags.get(flag)!;
      if (i + 1 >= argv.length) {
        throw new Error(`parseWithdrawZkDryRunArgs: ${flag} requires a value`);
      }
      (out as Record<string, unknown>)[key] = argv[i + 1];
      i += 2;
      continue;
    }
    if (flag === "--known-operator") {
      if (i + 1 >= argv.length) {
        throw new Error(
          "parseWithdrawZkDryRunArgs: --known-operator requires a value"
        );
      }
      const raw = argv[i + 1];
      let normalized: string;
      try {
        normalized = new PublicKey(raw).toBase58();
      } catch {
        throw new Error(
          `parseWithdrawZkDryRunArgs: --known-operator has invalid public key: ${JSON.stringify(
            raw
          )}`
        );
      }
      if (!out.knownOperators) out.knownOperators = [];
      out.knownOperators.push(normalized);
      i += 2;
      continue;
    }
    throw new Error(`parseWithdrawZkDryRunArgs: unknown flag: ${flag}`);
  }

  if (rawComputeUnitLimit !== undefined) {
    out.computeUnitLimit = parseComputeUnitLimit(rawComputeUnitLimit);
  }

  for (const [flag, key] of REQUIRED_VALUE_FLAGS) {
    if (out[key] === undefined) {
      throw new Error(
        `parseWithdrawZkDryRunArgs: missing required argument ${flag}`
      );
    }
  }

  // Validate --expected-root format whenever provided (any mode)
  if (out.expectedRoot !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(out.expectedRoot)) {
      throw new Error(
        `parseWithdrawZkDryRunArgs: --expected-root must be exactly 64 hex characters, got ${JSON.stringify(
          out.expectedRoot
        )}`
      );
    }
  }

  // Mutual exclusion
  if (out.simulate === true && out.send === true) {
    throw new Error(
      "Cannot specify both --simulate and --send: live send includes a mandatory " +
        "internal pre-flight simulation; remove --simulate to proceed."
    );
  }

  if (out.simulate === true) {
    if (!out.rpc) {
      throw new Error("parseWithdrawZkDryRunArgs: --simulate requires --rpc");
    }
    rejectMainnetRpc(out.rpc);
    if (out.computeUnitLimit === undefined) {
      out.computeUnitLimit = DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT;
    }
    if (out.relayerKeypair !== undefined) {
      throw new Error(
        "parseWithdrawZkDryRunArgs: --relayer-keypair requires --send"
      );
    }
  } else if (out.send === true) {
    if (!out.rpc) {
      throw new Error("parseWithdrawZkDryRunArgs: --send requires --rpc");
    }
    requireDevnetSendRpc(out.rpc);
    if (!out.expectedRoot) {
      throw new Error(
        "parseWithdrawZkDryRunArgs: --send requires --expected-root <64-char hex>"
      );
    }
    if (!out.relayerKeypair) {
      throw new Error(
        "parseWithdrawZkDryRunArgs: --send requires --relayer-keypair"
      );
    }
    if (!out.confirmPhrase) {
      throw new Error(
        'parseWithdrawZkDryRunArgs: --send requires --confirm "SEND WITHDRAW_ZK TO DEVNET"'
      );
    }
    if (out.confirmPhrase !== "SEND WITHDRAW_ZK TO DEVNET") {
      throw new Error(
        `parseWithdrawZkDryRunArgs: --confirm must be exactly "SEND WITHDRAW_ZK TO DEVNET", got ${JSON.stringify(
          out.confirmPhrase
        )}`
      );
    }
    if (out.computeUnitLimit === undefined) {
      out.computeUnitLimit = DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT;
    }
  } else {
    // Dry-run only
    if (out.rpc !== undefined) {
      throw new Error("parseWithdrawZkDryRunArgs: --rpc requires --simulate");
    }
    if (out.computeUnitLimit !== undefined) {
      throw new Error(
        "parseWithdrawZkDryRunArgs: --compute-unit-limit requires --simulate or --send"
      );
    }
    if (out.relayerKeypair !== undefined) {
      throw new Error(
        "parseWithdrawZkDryRunArgs: --relayer-keypair requires --send"
      );
    }
    if (out.confirmPhrase !== undefined) {
      throw new Error("parseWithdrawZkDryRunArgs: --confirm requires --send");
    }
  }

  return out as WithdrawZkDryRunArgs;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function parsePubkey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(
      `withdraw_zk dry-run: invalid public key for ${label}: ${JSON.stringify(
        value
      )}`
    );
  }
}

function readJson(
  filePath: string,
  label: string,
  rfSync: (p: string) => string
): unknown {
  let raw: string;
  try {
    raw = rfSync(filePath);
  } catch (e) {
    throw new Error(
      `withdraw_zk dry-run: cannot read ${label} at ${filePath}: ${
        (e as Error).message
      }`
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `withdraw_zk dry-run: invalid JSON in ${label} (${filePath}): ${
        (e as Error).message
      }`
    );
  }
}

// ── Summary builder ────────────────────────────────────────────────────────────

interface WithdrawZkDryRunBuildResult {
  summary: WithdrawZkDryRunSummary;
  instruction: TransactionInstruction;
  relayer: PublicKey;
}

function buildWithdrawZkDryRunResult(
  args: WithdrawZkDryRunArgs,
  deps?: {
    readFileSync?: (p: string) => string;
    cwd?: () => string;
  }
): WithdrawZkDryRunBuildResult {
  const rfSync =
    deps?.readFileSync ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const cwd = deps?.cwd ?? (() => process.cwd());
  const baseDir = cwd();
  const repoRoot = args.repoRoot ?? baseDir;

  // 1. Detect raw artifact path warnings
  const warnings = detectWithdrawZkRawArtifactPathWarnings(
    [args.proofJson, args.publicJson, args.inputJson],
    repoRoot,
    baseDir
  );
  if (warnings.length > 0 && !args.allowInRepoArtifacts) {
    throw new Error(
      `withdraw_zk dry-run: raw artifact paths are inside the repository:\n` +
        warnings.map((w) => `  ${w}`).join("\n") +
        "\n" +
        `Pass --allow-in-repo-artifacts to continue anyway.`
    );
  }

  // 2. Read and parse JSON files
  const proofRaw = readJson(args.proofJson, "proof-json", rfSync);
  const publicRaw = readJson(args.publicJson, "public-json", rfSync);
  const inputRaw = readJson(args.inputJson, "input-json", rfSync);

  // 3. Parse public inputs (root, nullifier_hash, tx_hash)
  const publicInputs = parseWithdrawZkPublicInputs(publicRaw);

  // 3b. Validate --expected-root against public.json root (any mode)
  if (args.expectedRoot !== undefined) {
    const normalizedExpected = args.expectedRoot.toLowerCase();
    if (normalizedExpected !== publicInputs.rootBeHex) {
      throw new Error(
        `withdraw_zk: --expected-root mismatch: CLI says ${normalizedExpected}, proof says ${publicInputs.rootBeHex}`
      );
    }
  }

  // 4. Parse input scalars and validate tx_hash against public inputs
  const scalars = parseWithdrawZkInputScalars(inputRaw);
  const consistency = validateWithdrawZkScalarsAgainstPublicInputs(
    scalars,
    publicInputs
  );
  if (!consistency.ok) {
    throw new Error(
      `withdraw_zk dry-run: input.json/public.json mismatch for: ${consistency.mismatches.join(
        ", "
      )}`
    );
  }

  // 4b. Cross-check root and nullifier_hash if present in input.json
  const inputObj = inputRaw as Record<string, unknown>;
  if (typeof inputObj.root === "string") {
    let normalizedRoot: string;
    try {
      normalizedRoot = normalizeHexOrDecimalToHex32(inputObj.root, "root");
    } catch {
      throw new Error(
        `withdraw_zk dry-run: input.json/public.json mismatch for: root (invalid format in input.json)`
      );
    }
    if (normalizedRoot !== publicInputs.rootBeHex) {
      throw new Error(
        `withdraw_zk dry-run: input.json/public.json mismatch for: root`
      );
    }
  }
  if (typeof inputObj.nullifier_hash === "string") {
    let normalizedNH: string;
    try {
      normalizedNH = normalizeHexOrDecimalToHex32(
        inputObj.nullifier_hash,
        "nullifier_hash"
      );
    } catch {
      throw new Error(
        `withdraw_zk dry-run: input.json/public.json mismatch for: nullifier_hash (invalid format in input.json)`
      );
    }
    if (normalizedNH !== publicInputs.nullifierHashBeHex) {
      throw new Error(
        `withdraw_zk dry-run: input.json/public.json mismatch for: nullifier_hash`
      );
    }
  }

  // 5. Parse CLI scalar args
  const cliDenomination = decimalStringToBigIntStrict(args.denomination);
  const cliFee = decimalStringToBigIntStrict(args.fee);
  const cliExpirySlot = decimalStringToBigIntStrict(args.expirySlot);
  const cliCircuitVersion = decimalStringToBigIntStrict(args.circuitVersion);

  // 6. Compare input.json scalars against CLI args where present
  const scalarComparisons: Array<[string | undefined, bigint, string]> = [
    [scalars.denomination, cliDenomination, "denomination"],
    [scalars.fee, cliFee, "fee"],
    [scalars.expirySlot, cliExpirySlot, "expiry_slot"],
    [scalars.circuitVersion, cliCircuitVersion, "circuit_version"],
  ];
  for (const [inputStr, cliVal, fieldName] of scalarComparisons) {
    if (inputStr !== undefined) {
      const inputVal = decimalStringToBigIntStrict(inputStr);
      if (inputVal !== cliVal) {
        throw new Error(
          `withdraw_zk dry-run: ${fieldName} mismatch: input.json has ${inputStr}, CLI has ${cliVal}`
        );
      }
    }
  }

  // 7. Encode proof bytes
  const encoded = encodeSnarkjsGroth16Proof(proofRaw as ZkProofJson);

  // 8. Parse public keys
  const programIdPk = parsePubkey(args.programId, "program-id");
  const relayerPk = parsePubkey(args.relayer, "relayer");
  const recipientPk = parsePubkey(args.recipient, "recipient");

  // 8b. Hygiene warnings — non-blocking, observable conditions only
  if (recipientPk.toBase58() === relayerPk.toBase58()) {
    warnings.push(
      "[RECIPIENT_EQUALS_RELAYER] Recipient and relayer are the same address. " +
        "On-chain settlement is transparent; this collapses two observable identities into one."
    );
  }
  if (!STANDARD_DENOMINATION_BUCKETS.has(cliDenomination)) {
    warnings.push(
      `[NON_STANDARD_DENOMINATION_BUCKET] Denomination ${cliDenomination} lamports is not a standard bucket. ` +
        "Non-standard denominations are more easily distinguished on-chain."
    );
  }
  if (args.knownOperators && args.knownOperators.length > 0) {
    const knownSet = new Set(args.knownOperators);
    if (knownSet.has(recipientPk.toBase58())) {
      warnings.push(
        "[RECIPIENT_MATCHES_KNOWN_OPERATOR] Recipient matches an operator-provided known address. " +
          "This is acceptable for controlled devnet tests but weak privacy hygiene."
      );
    }
    if (knownSet.has(relayerPk.toBase58())) {
      warnings.push(
        "[RELAYER_MATCHES_KNOWN_OPERATOR] Relayer matches an operator-provided known address. " +
          "This can concentrate observable roles in devnet-alpha operations."
      );
    }
  }

  // 9. Derive PDAs
  const [poolStatePk] = deriveWithdrawZkPoolStatePda(programIdPk);
  const [configPk] = deriveWithdrawZkVerifierConfigPda(programIdPk);
  const [nullifierMarkerPk] = deriveWithdrawZkNullifierMarkerPda(
    programIdPk,
    publicInputs.nullifierHashBeHex
  );

  // 10. Build instruction data (360 bytes)
  const instructionData = buildWithdrawZkInstructionData({
    proofA: Uint8Array.from(encoded.proofA),
    proofB: Uint8Array.from(encoded.proofB),
    proofC: Uint8Array.from(encoded.proofC),
    rootBeHex: publicInputs.rootBeHex,
    nullifierHashBeHex: publicInputs.nullifierHashBeHex,
    denomination: cliDenomination,
    fee: cliFee,
    expirySlot: cliExpirySlot,
    circuitVersion: cliCircuitVersion,
  });

  // 11. Build TransactionInstruction
  const ix = buildWithdrawZkInstruction({
    programId: programIdPk,
    relayer: relayerPk,
    poolState: poolStatePk,
    config: configPk,
    nullifierMarker: nullifierMarkerPk,
    recipient: recipientPk,
    data: instructionData,
  });

  return {
    summary: {
      programId: programIdPk.toBase58(),
      relayer: relayerPk.toBase58(),
      recipient: recipientPk.toBase58(),
      poolState: poolStatePk.toBase58(),
      config: configPk.toBase58(),
      nullifierMarker: nullifierMarkerPk.toBase58(),
      rootBeHex: publicInputs.rootBeHex,
      nullifierHashBeHex: publicInputs.nullifierHashBeHex,
      txHashBeHex: publicInputs.txHashBeHex,
      instructionDataLength: ix.data.length,
      keyCount: ix.keys.length,
      warnings,
    },
    instruction: ix,
    relayer: relayerPk,
  };
}

export function buildWithdrawZkDryRunSummary(
  args: WithdrawZkDryRunArgs,
  deps?: {
    readFileSync?: (p: string) => string;
    cwd?: () => string;
  }
): WithdrawZkDryRunSummary {
  return buildWithdrawZkDryRunResult(args, deps).summary;
}

// ── Simulation transaction builder ───────────────────────────────────────────

export interface WithdrawZkSimulationTransactionInput {
  relayer: PublicKey;
  recentBlockhash: string;
  computeUnitLimit: number;
  withdrawZkInstruction: TransactionInstruction;
}

export function buildWithdrawZkSimulationTransaction(
  input: WithdrawZkSimulationTransactionInput
): Transaction {
  const { relayer, recentBlockhash, computeUnitLimit, withdrawZkInstruction } =
    input;

  if (!(relayer instanceof PublicKey)) {
    throw new Error(
      "buildWithdrawZkSimulationTransaction: relayer must be a PublicKey"
    );
  }
  if (typeof recentBlockhash !== "string" || recentBlockhash.length === 0) {
    throw new Error(
      "buildWithdrawZkSimulationTransaction: recentBlockhash must be a non-empty string"
    );
  }
  if (
    !Number.isSafeInteger(computeUnitLimit) ||
    computeUnitLimit < 1 ||
    computeUnitLimit > MAX_WITHDRAW_ZK_SIMULATE_CU_LIMIT
  ) {
    throw new Error(
      `buildWithdrawZkSimulationTransaction: computeUnitLimit must be an integer in [1, ${MAX_WITHDRAW_ZK_SIMULATE_CU_LIMIT}], got ${computeUnitLimit}`
    );
  }
  if (!(withdrawZkInstruction instanceof TransactionInstruction)) {
    throw new Error(
      "buildWithdrawZkSimulationTransaction: withdrawZkInstruction must be a TransactionInstruction"
    );
  }

  const tx = new Transaction();
  tx.feePayer = relayer;
  tx.recentBlockhash = recentBlockhash;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  tx.add(withdrawZkInstruction);
  return tx;
}

// ── Simulation runner ─────────────────────────────────────────────────────────

export async function buildWithdrawZkSimulationSummary(
  args: WithdrawZkDryRunArgs,
  deps: {
    connection: WithdrawZkSimulationConnection;
    readFileSync?: (p: string) => string;
    cwd?: () => string;
  }
): Promise<WithdrawZkSimulationSummary> {
  if (args.simulate !== true) {
    throw new Error("buildWithdrawZkSimulationSummary: simulate must be true");
  }
  if (!args.rpc) {
    throw new Error("buildWithdrawZkSimulationSummary: rpc is required");
  }

  const dryRun = buildWithdrawZkDryRunResult(args, deps);
  const computeUnitLimit =
    args.computeUnitLimit ?? DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT;

  const blockhash = await deps.connection.getLatestBlockhash();

  const tx = buildWithdrawZkSimulationTransaction({
    relayer: dryRun.relayer,
    recentBlockhash: blockhash.blockhash,
    computeUnitLimit,
    withdrawZkInstruction: dryRun.instruction,
  });

  const sim = await deps.connection.simulateTransaction(tx);
  const logs = sim.value.logs ?? [];
  const warnings = [...dryRun.summary.warnings];

  if (
    typeof sim.value.unitsConsumed === "number" &&
    sim.value.unitsConsumed < 50_000
  ) {
    warnings.push(
      "Simulation consumed unexpectedly low CU; verify this is not a mock-verifier or incomplete verifier path."
    );
  }

  return {
    ...dryRun.summary,
    simulate: true,
    rpc: args.rpc,
    computeUnitLimit,
    recentBlockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    simulationOk: sim.value.err == null,
    simulationError: sim.value.err,
    unitsConsumed: sim.value.unitsConsumed,
    logs,
    warnings,
  };
}

// ── Real RPC connection adapters ──────────────────────────────────────────────

// The Connection.simulateTransaction(tx) legacy overload sends without signature
// verification when no signers are provided (sigVerify defaults to false).
// No transaction is signed or sent — this is a read-only RPC call.
export function createWithdrawZkSimulationConnection(
  rpc: string
): WithdrawZkSimulationConnection {
  const connection = new Connection(rpc, "confirmed");
  return {
    async getLatestBlockhash() {
      return connection.getLatestBlockhash("confirmed");
    },
    async simulateTransaction(tx: Transaction) {
      return connection.simulateTransaction(tx);
    },
  };
}

// Parse Borsh-encoded VerifierConfig account data to extract allowed_roots hex strings.
// Layout: [0,8) discriminator; [8,40) admin_authority; [40,72) attester_pubkey;
// [72,104) root_submitter_authority; [104,112) chain_id u64; [112) paused bool;
// [113) threshold u8; [114,118) verifier_pubkeys vec len; then verifier_pubkeys;
// then allowed_roots vec len; then allowed_roots (32 bytes each).
function parseAllowedRootsFromConfigAccount(data: Buffer): string[] {
  try {
    let offset = 8 + 32 + 32 + 32 + 8 + 1 + 1; // 114
    if (data.length < offset + 4) return [];
    const vpLen = data.readUInt32LE(offset);
    offset += 4 + vpLen * 32;
    if (data.length < offset + 4) return [];
    const arLen = data.readUInt32LE(offset);
    offset += 4;
    if (data.length < offset + arLen * 32) return [];
    const roots: string[] = [];
    for (let i = 0; i < arLen; i++) {
      roots.push(data.subarray(offset, offset + 32).toString("hex"));
      offset += 32;
    }
    return roots;
  } catch {
    return [];
  }
}

function resolveDevnetRpcUrl(rpc: string): string {
  if (rpc === "devnet" || rpc === "d") return "https://api.devnet.solana.com";
  return rpc;
}

export function createWithdrawZkSendConnection(
  rpc: string
): WithdrawZkSendConnection {
  const connection = new Connection(resolveDevnetRpcUrl(rpc), "confirmed");
  return {
    async getLatestBlockhash() {
      const bh = await connection.getLatestBlockhash("confirmed");
      return {
        blockhash: bh.blockhash,
        lastValidBlockHeight: bh.lastValidBlockHeight,
      };
    },
    async simulateTransaction(tx: Transaction) {
      return connection.simulateTransaction(tx);
    },
    async getSlot() {
      return connection.getSlot("confirmed");
    },
    async getNullifierMarkerExists(pubkey: PublicKey) {
      const info = await connection.getAccountInfo(pubkey, "confirmed");
      return info !== null;
    },
    async getPoolRawLamports(pubkey: PublicKey) {
      const info = await connection.getAccountInfo(pubkey, "confirmed");
      if (!info) return 0n;
      return BigInt(info.lamports);
    },
    async getConfigAllowedRoots(configPda: PublicKey) {
      const info = await connection.getAccountInfo(configPda, "confirmed");
      if (!info) return [];
      return parseAllowedRootsFromConfigAccount(
        Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data)
      );
    },
    async sendRawTransaction(
      rawTransaction: Buffer,
      opts: { skipPreflight: boolean }
    ) {
      return connection.sendRawTransaction(rawTransaction, opts);
    },
    async confirmTransaction(
      opts: {
        signature: string;
        blockhash: string;
        lastValidBlockHeight: number;
      },
      commitment: "confirmed"
    ) {
      return connection.confirmTransaction(opts, commitment);
    },
  };
}

// ── Printer ────────────────────────────────────────────────────────────────────

function printSummary(
  summary: WithdrawZkDryRunSummary,
  jsonMode: boolean,
  stdout: (line: string) => void = (line) => console.log(line)
): void {
  if (jsonMode) {
    stdout(JSON.stringify(summary, null, 2));
    return;
  }
  stdout("=== withdraw_zk dry-run summary ===");
  stdout("mode:               dry-run — no RPC, simulation, signing, or send");
  stdout(`programId:          ${summary.programId}`);
  stdout(`relayer:            ${summary.relayer}`);
  stdout(`recipient:          ${summary.recipient}`);
  stdout(`poolState PDA:      ${summary.poolState}`);
  stdout(`config PDA:         ${summary.config}`);
  stdout(`nullifierMarker:    ${summary.nullifierMarker}`);
  stdout(`root:               ${summary.rootBeHex}`);
  stdout(`nullifier_hash:     ${summary.nullifierHashBeHex}`);
  stdout(`tx_hash:            ${summary.txHashBeHex}`);
  stdout(`instruction data:   ${summary.instructionDataLength} bytes`);
  stdout(`key count:          ${summary.keyCount}`);
  if (summary.warnings.length > 0) {
    stdout("warnings:");
    for (const w of summary.warnings) {
      stdout(`  ${w}`);
    }
  }
  stdout("===================================");
}

function printSimulationSummary(
  summary: WithdrawZkSimulationSummary,
  jsonMode: boolean,
  stdout: (line: string) => void = (line) => console.log(line)
): void {
  if (jsonMode) {
    stdout(JSON.stringify(summary, null, 2));
    return;
  }
  stdout("=== withdraw_zk simulation summary ===");
  stdout("mode:                 devnet simulation — no signing or send");
  stdout(`rpc:                  ${summary.rpc ?? "(unknown)"}`);
  stdout(`programId:            ${summary.programId}`);
  stdout(`relayer:              ${summary.relayer}`);
  stdout(`recipient:            ${summary.recipient}`);
  stdout(`poolState PDA:        ${summary.poolState}`);
  stdout(`config PDA:           ${summary.config}`);
  stdout(`nullifierMarker:      ${summary.nullifierMarker}`);
  stdout(`computeUnitLimit:     ${summary.computeUnitLimit}`);
  stdout(`recentBlockhash:      ${summary.recentBlockhash}`);
  if (summary.lastValidBlockHeight !== undefined) {
    stdout(`lastValidBlockHeight: ${summary.lastValidBlockHeight}`);
  }
  stdout(`simulationOk:         ${summary.simulationOk}`);
  if (summary.simulationError != null) {
    stdout(`simulationError:      ${JSON.stringify(summary.simulationError)}`);
  }
  if (summary.unitsConsumed !== undefined) {
    stdout(`unitsConsumed:        ${summary.unitsConsumed}`);
  }
  stdout(`instruction data:     ${summary.instructionDataLength} bytes`);
  stdout(`key count:            ${summary.keyCount}`);
  stdout(`logs:                 ${summary.logs.length}`);
  const tail = summary.logs.slice(-10);
  for (const line of tail) {
    stdout(`  ${line}`);
  }
  if (summary.warnings.length > 0) {
    stdout("warnings:");
    for (const w of summary.warnings) {
      stdout(`  ${w}`);
    }
  }
  stdout("note:                 no transaction was signed or sent");
  stdout("======================================");
}

// ── CLI deps ──────────────────────────────────────────────────────────────────

export interface WithdrawZkCliDeps {
  readFileSync?: (p: string) => string;
  cwd?: () => string;
  createConnection?: (rpc: string) => WithdrawZkSimulationConnection;
  createSendConnection?: (rpc: string) => WithdrawZkSendConnection;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

// ── Send runner ───────────────────────────────────────────────────────────────

async function runWithdrawZkSend(
  args: WithdrawZkDryRunArgs,
  deps: WithdrawZkCliDeps,
  connection: WithdrawZkSendConnection
): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const rfSync =
    deps.readFileSync ?? ((p: string) => fs.readFileSync(p, "utf8"));

  // Guard 1: Build dry-run result (reads and validates proof files, checks --expected-root)
  let dryRun: WithdrawZkDryRunBuildResult;
  try {
    dryRun = buildWithdrawZkDryRunResult(args, deps);
  } catch (e) {
    stderr((e as Error).message);
    return 1;
  }

  // Guard 2: Load and validate relayer keypair
  let relayerKeypair: Keypair;
  try {
    const keyData = JSON.parse(rfSync(args.relayerKeypair!));
    relayerKeypair = Keypair.fromSecretKey(Uint8Array.from(keyData));
  } catch (e) {
    stderr(
      `withdraw_zk send: failed to load relayer keypair from ${
        args.relayerKeypair
      }: ${(e as Error).message}`
    );
    return 1;
  }

  if (relayerKeypair.publicKey.toBase58() !== args.relayer) {
    stderr(
      `withdraw_zk send: relayer-keypair pubkey ${relayerKeypair.publicKey.toBase58()} does not match --relayer ${
        args.relayer
      }`
    );
    return 1;
  }

  // Guard 3: Fetch current slot and check expiry buffer
  let currentSlot: number;
  try {
    currentSlot = await connection.getSlot();
  } catch (e) {
    stderr(
      `withdraw_zk send: failed to get current slot: ${(e as Error).message}`
    );
    return 1;
  }

  const expirySlot = Number(decimalStringToBigIntStrict(args.expirySlot));
  const slotsRemaining = expirySlot - currentSlot;

  if (slotsRemaining < MIN_SEND_EXPIRY_BUFFER) {
    stderr(
      `withdraw_zk send: expiry buffer too low: ${slotsRemaining} slots remaining, ` +
        `need >= ${MIN_SEND_EXPIRY_BUFFER} (expiry_slot=${expirySlot}, current_slot=${currentSlot})`
    );
    return 1;
  }

  const configPk = new PublicKey(dryRun.summary.config);
  const nullifierMarkerPk = new PublicKey(dryRun.summary.nullifierMarker);
  const poolStatePk = new PublicKey(dryRun.summary.poolState);
  const denomination = decimalStringToBigIntStrict(args.denomination);
  const fee = decimalStringToBigIntStrict(args.fee);

  // Guard 4: Check root is in allowed_roots
  let allowedRoots: string[];
  try {
    allowedRoots = await connection.getConfigAllowedRoots(configPk);
  } catch (e) {
    stderr(
      `withdraw_zk send: failed to fetch allowed roots: ${(e as Error).message}`
    );
    return 1;
  }

  if (!allowedRoots.includes(dryRun.summary.rootBeHex)) {
    stderr(
      `withdraw_zk send: root ${dryRun.summary.rootBeHex} is not in allowed_roots (${allowedRoots.length} entries)`
    );
    return 1;
  }

  // Guard 5: Check nullifier marker does not exist
  let nullifierExists: boolean;
  try {
    nullifierExists = await connection.getNullifierMarkerExists(
      nullifierMarkerPk
    );
  } catch (e) {
    stderr(
      `withdraw_zk send: failed to check nullifier marker: ${
        (e as Error).message
      }`
    );
    return 1;
  }

  if (nullifierExists) {
    stderr(
      `withdraw_zk send: nullifier marker already exists at ${nullifierMarkerPk.toBase58()} — note already spent`
    );
    return 1;
  }

  // Guard 6: Check pool raw lamports >= denomination
  let poolLamports: bigint;
  try {
    poolLamports = await connection.getPoolRawLamports(poolStatePk);
  } catch (e) {
    stderr(
      `withdraw_zk send: failed to fetch pool balance: ${(e as Error).message}`
    );
    return 1;
  }

  if (poolLamports < denomination) {
    stderr(
      `withdraw_zk send: pool has insufficient lamports: pool has ${poolLamports}, denomination requires ${denomination}`
    );
    return 1;
  }

  // Guard 7: Mandatory pre-send simulation (blockhash 1)
  const computeUnitLimit =
    args.computeUnitLimit ?? DEFAULT_WITHDRAW_ZK_SIMULATE_CU_LIMIT;

  let simBlockhash: { blockhash: string; lastValidBlockHeight: number };
  try {
    simBlockhash = await connection.getLatestBlockhash();
  } catch (e) {
    stderr(
      `withdraw_zk send: failed to fetch blockhash for simulation: ${
        (e as Error).message
      }`
    );
    return 1;
  }

  const simTx = buildWithdrawZkSimulationTransaction({
    relayer: dryRun.relayer,
    recentBlockhash: simBlockhash.blockhash,
    computeUnitLimit,
    withdrawZkInstruction: dryRun.instruction,
  });

  let simResult: {
    value: { err: unknown; logs?: string[] | null; unitsConsumed?: number };
  };
  try {
    simResult = await connection.simulateTransaction(simTx);
  } catch (e) {
    stderr(`withdraw_zk send: simulation threw: ${(e as Error).message}`);
    return 1;
  }

  if (simResult.value.err != null) {
    stderr(
      `withdraw_zk send: pre-send simulation failed: ${JSON.stringify(
        simResult.value.err
      )}`
    );
    return 1;
  }

  // Print pre-send summary to stderr (always, even in --json mode)
  stderr("=== withdraw_zk LIVE SEND ===");
  stderr("mode:             LIVE SEND — this will permanently spend the note");
  stderr(`program:          ${args.programId}`);
  stderr(`rpc:              ${args.rpc}`);
  stderr(`payer/relayer:    ${args.relayer}`);
  stderr(`recipient:        ${args.recipient}`);
  stderr(`denomination:     ${denomination} lamports`);
  stderr(`fee:              ${fee} lamports`);
  stderr(`recipient gets:   ${denomination - fee} lamports`);
  stderr(`root:             ${dryRun.summary.rootBeHex}`);
  stderr(`nullifier_hash:   ${dryRun.summary.nullifierHashBeHex}`);
  stderr(`nullifier PDA:    ${nullifierMarkerPk.toBase58()}`);
  stderr(`tx_hash:          ${dryRun.summary.txHashBeHex}`);
  stderr(`current slot:     ${currentSlot}`);
  stderr(`expiry slot:      ${expirySlot}`);
  stderr(`slots remaining:  ${slotsRemaining}`);
  stderr(`compute limit:    ${computeUnitLimit}`);
  stderr(`pool lamports:    ${poolLamports}`);
  stderr(
    "WARNING:          This note will be permanently spent on devnet. The nullifier cannot be reused."
  );
  stderr("============================");

  // Fetch fresh blockhash for the actual send (blockhash 2)
  let sendBlockhash: { blockhash: string; lastValidBlockHeight: number };
  try {
    sendBlockhash = await connection.getLatestBlockhash();
  } catch (e) {
    stderr(
      `withdraw_zk send: failed to fetch fresh blockhash for send: ${
        (e as Error).message
      }`
    );
    return 1;
  }

  // Build and sign send transaction with fresh blockhash
  const sendTx = buildWithdrawZkSimulationTransaction({
    relayer: dryRun.relayer,
    recentBlockhash: sendBlockhash.blockhash,
    computeUnitLimit,
    withdrawZkInstruction: dryRun.instruction,
  });
  sendTx.sign(relayerKeypair);

  // Broadcast with skipPreflight (simulation already passed)
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(
      Buffer.from(sendTx.serialize()),
      { skipPreflight: true }
    );
  } catch (e) {
    stderr(
      `withdraw_zk send: sendRawTransaction failed: ${(e as Error).message}`
    );
    return 1;
  }

  // Print signature immediately after broadcast
  stderr(`broadcast: ${signature}`);

  // Confirm with lastValidBlockHeight form
  let confirmResult: { value: { err: unknown } };
  try {
    confirmResult = await connection.confirmTransaction(
      {
        signature,
        blockhash: sendBlockhash.blockhash,
        lastValidBlockHeight: sendBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );
  } catch (e) {
    stderr(
      `withdraw_zk send: confirmTransaction failed: ${(e as Error).message}`
    );
    stderr(`signature: ${signature}`);
    stderr(
      "WARNING: The transaction may have landed. Do not blindly retry; check signature and nullifier marker first."
    );
    return 1;
  }

  if (confirmResult.value.err != null) {
    stderr(
      `withdraw_zk send: transaction confirmed but failed on-chain: ${JSON.stringify(
        confirmResult.value.err
      )}`
    );
    stderr(`signature: ${signature}`);
    stderr(
      "WARNING: The transaction may have landed. Do not blindly retry; check signature and nullifier marker first."
    );
    return 1;
  }

  // Success
  stderr("withdraw_zk send: SUCCESS — note permanently consumed on devnet");
  stderr(`nullifier marker PDA: ${nullifierMarkerPk.toBase58()}`);
  stderr(
    "NOTE: This note is now permanently spent. The nullifier cannot be reused."
  );

  if (args.json === true) {
    stdout(
      JSON.stringify(
        {
          mode: "send",
          signature,
          programId: args.programId,
          relayer: args.relayer,
          recipient: args.recipient,
          denomination: denomination.toString(),
          fee: fee.toString(),
          recipientGets: (denomination - fee).toString(),
          root: dryRun.summary.rootBeHex,
          nullifierHash: dryRun.summary.nullifierHashBeHex,
          nullifierMarker: nullifierMarkerPk.toBase58(),
          txHash: dryRun.summary.txHashBeHex,
          currentSlot,
          expirySlot,
          slotsRemaining,
          computeUnitLimit,
          poolLamports: poolLamports.toString(),
          unitsConsumed: simResult.value.unitsConsumed,
        },
        null,
        2
      )
    );
  }

  return 0;
}

// ── CLI runner ────────────────────────────────────────────────────────────────

export async function runWithdrawZkDevnetCli(
  argv: string[],
  deps: WithdrawZkCliDeps = {}
): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  let args: WithdrawZkDryRunArgs;
  try {
    args = parseWithdrawZkDryRunArgs(argv);
  } catch (e) {
    stderr((e as Error).message);
    return 1;
  }

  if (args.send === true) {
    const createSendConn =
      deps.createSendConnection ?? createWithdrawZkSendConnection;
    return runWithdrawZkSend(args, deps, createSendConn(args.rpc!));
  }

  if (args.simulate === true) {
    const createConnection =
      deps.createConnection ?? createWithdrawZkSimulationConnection;

    let summary: WithdrawZkSimulationSummary;
    try {
      summary = await buildWithdrawZkSimulationSummary(args, {
        connection: createConnection(args.rpc!),
        readFileSync: deps.readFileSync,
        cwd: deps.cwd,
      });
    } catch (e) {
      stderr((e as Error).message);
      return 1;
    }

    printSimulationSummary(summary, args.json === true, stdout);
    return summary.simulationOk ? 0 : 1;
  }

  let summary: WithdrawZkDryRunSummary;
  try {
    summary = buildWithdrawZkDryRunSummary(args, {
      readFileSync: deps.readFileSync,
      cwd: deps.cwd,
    });
  } catch (e) {
    stderr((e as Error).message);
    return 1;
  }

  printSummary(summary, args.json === true, stdout);
  return 0;
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function main(argv?: string[]): Promise<void> {
  const code = await runWithdrawZkDevnetCli(argv ?? process.argv.slice(2));
  if (code !== 0) {
    process.exit(code);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
