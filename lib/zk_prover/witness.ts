// Phase 4 prover-input / witness export library.
//
// Produces WitnessJson (private prover inputs) and PublicInputsJson (public inputs)
// from a local indexer snapshot, a note secret, and withdrawal transaction parameters.
//
// This module does NOT generate or verify Groth16 proofs.
// This module does NOT submit roots or send transactions.
// This module does NOT open RPC connections.
//
// SECURITY: The note secret is accepted as a bigint. Callers must never log,
// print, or persist the raw secret value. See docs/PHASE4_WITNESS_EXPORT.md.
//
// Requires initPoseidon() from lib/zk_indexer/poseidon.ts to be called before
// any hash computation.
//
// Public input order (locked — matches spec §1):
//   public[0] = root
//   public[1] = nullifier_hash
//   public[2] = tx_hash

import { PublicKey } from "@solana/web3.js";
import {
  poseidonHash,
  hexToFrBigInt,
  frBigIntToHex32,
} from "../zk_indexer/poseidon";
import {
  TAG_LEAF,
  TAG_NULLIFIER,
  TAG_TX,
  TAG_TX_INNER,
  CIRCUIT_VERSION as DEFAULT_CIRCUIT_VERSION,
  BN254_FR_MODULUS_HEX,
  TREE_DEPTH,
} from "../zk_indexer/constants";
import { loadSnapshot } from "../zk_indexer/persistence";

const BN254_FR_MODULUS = BigInt("0x" + BN254_FR_MODULUS_HEX);

// ── Output types ─────────────────────────────────────────────────────────────

export interface PublicInputsJson {
  public_inputs_order: ["root", "nullifier_hash", "tx_hash"];
  root_be_hex: string;
  nullifier_hash_be_hex: string;
  tx_hash_be_hex: string;
}

export interface WitnessJson {
  circuit_version: string;
  leaf_index: number;
  commitment_be_hex: string;
  root_be_hex: string;
  path_elements_be_hex: string[];
  path_indices: number[];
  nullifier_hash_be_hex: string;
  pubkeys_hash_be_hex: string;
  tx_hash_be_hex: string;
  denomination: string;
  fee: string;
  chain_id: string;
  expiry_slot: string;
}

// ── Validation helpers ────────────────────────────────────────────────────────

function assertCanonicalFr(value: bigint, label: string): void {
  if (value < 0n || value >= BN254_FR_MODULUS) {
    throw new Error(
      `${label}: not a canonical BN254 Fr element (value must be in [0, p-1])`
    );
  }
}

function assertHex64(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `${label}: expected 64-char lowercase hex, got length ${value.length}`
    );
  }
}

function assertDecimalString(value: string, label: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(
      `${label}: expected strict non-negative decimal string ` +
        `(no leading zeros, no hex prefix, no negatives), got ${JSON.stringify(
          value
        )}`
    );
  }
}

// ── Pubkey helpers ────────────────────────────────────────────────────────────

function decodeKeyBytes(input: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return Buffer.from(input, "hex");
  }
  return Buffer.from(new PublicKey(input).toBytes());
}

/**
 * Split a 32-byte pubkey into two 128-bit little-endian BN254 Fr elements.
 *
 * Pubkey split convention (locked in spec §1):
 *   lo = bytes[0..16] interpreted as little-endian 128-bit integer
 *   hi = bytes[16..32] interpreted as little-endian 128-bit integer
 *
 * Endianness note: byte[0] is the least-significant byte of lo.
 * This is the mirror image of big-endian hash serialization — do not confuse
 * the two. Tests in tests/zk_prover_witness.ts pin this with known vectors.
 *
 * Accepts base58 Solana pubkey or 64-char hex (any case).
 */
export function splitPubkey(input: string): { lo: bigint; hi: bigint } {
  const bytes = decodeKeyBytes(input);
  let lo = 0n;
  for (let i = 0; i < 16; i++) {
    lo |= BigInt(bytes[i]) << BigInt(i * 8);
  }
  let hi = 0n;
  for (let i = 0; i < 16; i++) {
    hi |= BigInt(bytes[16 + i]) << BigInt(i * 8);
  }
  return { lo, hi };
}

// ── Hash functions ────────────────────────────────────────────────────────────

/**
 * Compute note commitment from secret and denomination.
 * Formula (spec §1): note_leaf = Poseidon(TAG_LEAF, secret, denomination)
 *
 * Returns 64-char lowercase big-endian hex.
 * Both secret and denomination must be canonical BN254 Fr elements.
 */
export function computeNoteCommitment(
  secret: bigint,
  denomination: bigint
): string {
  assertCanonicalFr(secret, "secret");
  assertCanonicalFr(denomination, "denomination");
  return frBigIntToHex32(poseidonHash([TAG_LEAF, secret, denomination]));
}

/**
 * Compute nullifier hash from secret.
 * Formula (spec §1): nullifier_hash = Poseidon(TAG_NULLIFIER, secret)
 *
 * Returns 64-char lowercase big-endian hex.
 * secret must be a canonical BN254 Fr element.
 */
export function computeNullifierHash(secret: bigint): string {
  assertCanonicalFr(secret, "secret");
  return frBigIntToHex32(poseidonHash([TAG_NULLIFIER, secret]));
}

/**
 * Compute pubkeys hash from the five on-chain accounts.
 * Formula (spec §1):
 *   Poseidon(TAG_TX_INNER,
 *     pid_lo, pid_hi, pool_lo, pool_hi, cfg_lo, cfg_hi,
 *     rec_lo, rec_hi, rel_lo, rel_hi)
 *
 * Returns 64-char lowercase big-endian hex.
 * All pubkey arguments accepted as base58 Solana pubkeys or 64-char hex.
 */
export function computePubkeysHash(
  programId: string,
  poolPda: string,
  configPda: string,
  recipient: string,
  relayer: string
): string {
  const pid = splitPubkey(programId);
  const pool = splitPubkey(poolPda);
  const cfg = splitPubkey(configPda);
  const rec = splitPubkey(recipient);
  const rel = splitPubkey(relayer);
  return frBigIntToHex32(
    poseidonHash([
      TAG_TX_INNER,
      pid.lo,
      pid.hi,
      pool.lo,
      pool.hi,
      cfg.lo,
      cfg.hi,
      rec.lo,
      rec.hi,
      rel.lo,
      rel.hi,
    ])
  );
}

/**
 * Compute tx hash.
 * Formula (spec §1):
 *   Poseidon(TAG_TX, pubkeys_hash, denomination, fee, chain_id, expiry_slot, circuit_version)
 *
 * Returns 64-char lowercase big-endian hex.
 * pubkeysHashBeHex must be a 64-char lowercase hex string.
 * All numeric arguments must be canonical BN254 Fr elements.
 */
export function computeTxHash(
  pubkeysHashBeHex: string,
  denomination: bigint,
  fee: bigint,
  chainId: bigint,
  expirySlot: bigint,
  circuitVersion: bigint = DEFAULT_CIRCUIT_VERSION
): string {
  assertHex64(pubkeysHashBeHex, "pubkeysHashBeHex");
  assertCanonicalFr(denomination, "denomination");
  assertCanonicalFr(fee, "fee");
  assertCanonicalFr(chainId, "chainId");
  assertCanonicalFr(expirySlot, "expirySlot");
  assertCanonicalFr(circuitVersion, "circuitVersion");
  return frBigIntToHex32(
    poseidonHash([
      TAG_TX,
      hexToFrBigInt(pubkeysHashBeHex),
      denomination,
      fee,
      chainId,
      expirySlot,
      circuitVersion,
    ])
  );
}

// ── Main witness builder ──────────────────────────────────────────────────────

/**
 * Build witness and public inputs from a snapshot file.
 *
 * Requires initPoseidon() to have been called before use.
 *
 * @param snapshotPath - path to a v1 or v2 snapshot JSON
 * @param selector - select note by leafIndex or commitmentHex (mutually exclusive)
 * @param secret - note secret as BN254 Fr bigint (MUST be canonical; MUST NOT be logged)
 * @param params - withdrawal transaction parameters
 *
 * @returns witness (private prover inputs), publicInputs, and optional warnings
 *
 * Commitment mismatch: if Poseidon(TAG_LEAF, secret, denomination) does not match
 * the commitment stored at the selected leaf, throws with a descriptive error.
 * This enforces the note ownership check before witness export.
 */
export function buildWitnessFromSnapshot(
  snapshotPath: string,
  selector: { leafIndex?: number; commitmentHex?: string },
  secret: bigint,
  params: {
    programId: string;
    poolPda: string;
    configPda: string;
    recipient: string;
    relayer: string;
    denomination: bigint;
    fee: bigint;
    chainId: bigint;
    expirySlot: bigint;
    circuitVersion?: bigint;
  }
): {
  witness: WitnessJson;
  publicInputs: PublicInputsJson;
  warnings: string[];
} {
  assertCanonicalFr(secret, "secret");

  if (
    selector.leafIndex === undefined &&
    selector.commitmentHex === undefined
  ) {
    throw new Error(
      "buildWitnessFromSnapshot: provide either leafIndex or commitmentHex"
    );
  }
  if (
    selector.leafIndex !== undefined &&
    selector.commitmentHex !== undefined
  ) {
    throw new Error(
      "buildWitnessFromSnapshot: leafIndex and commitmentHex are mutually exclusive"
    );
  }

  const { events, tree } = loadSnapshot(snapshotPath);
  const warnings: string[] = [];

  let proof;
  if (selector.leafIndex !== undefined) {
    proof = tree.getProofByLeafIndex(selector.leafIndex);
  } else {
    const normalized = frBigIntToHex32(hexToFrBigInt(selector.commitmentHex!));
    const matchingIndices = events
      .filter((e) => e.commitment_be_hex === normalized)
      .map((e) => e.leaf_index);
    if (matchingIndices.length > 1) {
      warnings.push(
        `WARNING: commitment ${normalized.slice(
          0,
          8
        )}... appears at leaf indices ` +
          `${matchingIndices.join(", ")}. Using first occurrence (leaf_index=${
            matchingIndices[0]
          }). ` +
          `Use --leaf-index to select a specific occurrence.`
      );
    }
    proof = tree.getProofByCommitment(selector.commitmentHex!);
  }

  if (proof.path_elements_be_hex.length !== TREE_DEPTH) {
    throw new Error(
      `buildWitnessFromSnapshot: path_elements length ${proof.path_elements_be_hex.length} !== TREE_DEPTH ${TREE_DEPTH}`
    );
  }
  if (proof.path_indices.length !== TREE_DEPTH) {
    throw new Error(
      `buildWitnessFromSnapshot: path_indices length ${proof.path_indices.length} !== TREE_DEPTH ${TREE_DEPTH}`
    );
  }

  // Validate note ownership: recompute commitment from secret + denomination
  const recomputed = computeNoteCommitment(secret, params.denomination);
  if (recomputed !== proof.commitment_be_hex) {
    throw new Error(
      "buildWitnessFromSnapshot: recomputed note commitment does not match " +
        "snapshot commitment. Verify that secret and denomination are correct for this note."
    );
  }

  const nullifierHashHex = computeNullifierHash(secret);
  const pubkeysHashHex = computePubkeysHash(
    params.programId,
    params.poolPda,
    params.configPda,
    params.recipient,
    params.relayer
  );
  const circuitVersion = params.circuitVersion ?? DEFAULT_CIRCUIT_VERSION;
  const txHashHex = computeTxHash(
    pubkeysHashHex,
    params.denomination,
    params.fee,
    params.chainId,
    params.expirySlot,
    circuitVersion
  );

  assertHex64(proof.root_be_hex, "root_be_hex");
  assertHex64(nullifierHashHex, "nullifier_hash_be_hex");
  assertHex64(pubkeysHashHex, "pubkeys_hash_be_hex");
  assertHex64(txHashHex, "tx_hash_be_hex");

  const witness: WitnessJson = {
    circuit_version: circuitVersion.toString(),
    leaf_index: proof.leaf_index,
    commitment_be_hex: proof.commitment_be_hex,
    root_be_hex: proof.root_be_hex,
    path_elements_be_hex: proof.path_elements_be_hex,
    path_indices: proof.path_indices,
    nullifier_hash_be_hex: nullifierHashHex,
    pubkeys_hash_be_hex: pubkeysHashHex,
    tx_hash_be_hex: txHashHex,
    denomination: params.denomination.toString(),
    fee: params.fee.toString(),
    chain_id: params.chainId.toString(),
    expiry_slot: params.expirySlot.toString(),
  };

  const publicInputs: PublicInputsJson = {
    public_inputs_order: ["root", "nullifier_hash", "tx_hash"],
    root_be_hex: proof.root_be_hex,
    nullifier_hash_be_hex: nullifierHashHex,
    tx_hash_be_hex: txHashHex,
  };

  return { witness, publicInputs, warnings };
}

// ── Circom input JSON ─────────────────────────────────────────────────────────

/**
 * Complete snarkjs-compatible input JSON for the WITHDRAW_SOL_V1 circuit.
 *
 * All scalar values are strict non-negative decimal strings (no hex, no "0x",
 * no floats, no signs). Array values use the same format.
 *
 * Signal layout (21 total: 3 public + 18 private):
 *   Public : root, nullifier_hash, tx_hash
 *   Private: secret, denomination, path_elements[20], path_indices[20],
 *            program_id_lo, program_id_hi, pool_pda_lo, pool_pda_hi,
 *            config_pda_lo, config_pda_hi, recipient_lo, recipient_hi,
 *            relayer_lo, relayer_hi, fee, chain_id, expiry_slot, circuit_version
 *
 * SECURITY: This object contains `secret` as a decimal string. Do not log,
 * persist casually, or commit an object of this type. The caller is responsible
 * for secure handling and disposal.
 */
export interface WithdrawSolV1CircomInputJson {
  root: string;
  nullifier_hash: string;
  tx_hash: string;

  secret: string;
  denomination: string;

  path_elements: string[];
  path_indices: string[];

  program_id_lo: string;
  program_id_hi: string;
  pool_pda_lo: string;
  pool_pda_hi: string;
  config_pda_lo: string;
  config_pda_hi: string;
  recipient_lo: string;
  recipient_hi: string;
  relayer_lo: string;
  relayer_hi: string;

  fee: string;
  chain_id: string;
  expiry_slot: string;
  circuit_version: string;
}

/**
 * Build a snarkjs-compatible Circom input JSON for the WITHDRAW_SOL_V1 circuit.
 *
 * Converts a WitnessJson (hex-encoded, produced by buildWitnessFromSnapshot)
 * into decimal strings suitable for `snarkjs generate_witness.js`.
 *
 * Requires initPoseidon() to have been called before use.
 *
 * Consistency checks (in order):
 *   1. secret is a canonical BN254 Fr element (non-negative, < p)
 *   2. every path_indices value is exactly 0 or 1
 *   3. all hex fields are 64-char lowercase
 *   4. all decimal string fields match /^(0|[1-9][0-9]*)$/
 *   5. witness.circuit_version === CIRCUIT_VERSION ("1")
 *   6. computeNullifierHash(secret) === witness.nullifier_hash_be_hex
 *   7. computeNoteCommitment(secret, denomination) === witness.commitment_be_hex
 *   8. computePubkeysHash(accounts) === witness.pubkeys_hash_be_hex
 *   9. computeTxHash(pubkeys_hash, denomination, fee, chain_id, expiry_slot,
 *      circuit_version) === witness.tx_hash_be_hex
 *
 * @param witness - WitnessJson from buildWitnessFromSnapshot.
 * @param secret - The raw note secret as a canonical BN254 Fr bigint.
 *   SECURITY: Appears verbatim in the returned object. Handle accordingly.
 * @param accounts - The five on-chain Solana account pubkeys (base58) used
 *   when constructing the WitnessJson.
 */
export function buildWithdrawSolV1CircomInputJson(
  witness: WitnessJson,
  secret: bigint,
  accounts: {
    programId: string;
    poolPda: string;
    configPda: string;
    recipient: string;
    relayer: string;
  }
): WithdrawSolV1CircomInputJson {
  assertCanonicalFr(secret, "secret");

  if (witness.path_elements_be_hex.length !== TREE_DEPTH) {
    throw new Error(
      `buildWithdrawSolV1CircomInputJson: path_elements_be_hex length ` +
        `${witness.path_elements_be_hex.length} !== TREE_DEPTH ${TREE_DEPTH}`
    );
  }
  if (witness.path_indices.length !== TREE_DEPTH) {
    throw new Error(
      `buildWithdrawSolV1CircomInputJson: path_indices length ` +
        `${witness.path_indices.length} !== TREE_DEPTH ${TREE_DEPTH}`
    );
  }

  for (let i = 0; i < witness.path_indices.length; i++) {
    const v = witness.path_indices[i];
    if (v !== 0 && v !== 1) {
      throw new Error(
        `buildWithdrawSolV1CircomInputJson: path_indices[${i}] must be 0 or 1, got ${v}`
      );
    }
  }

  assertHex64(witness.root_be_hex, "witness.root_be_hex");
  assertHex64(witness.nullifier_hash_be_hex, "witness.nullifier_hash_be_hex");
  assertHex64(witness.tx_hash_be_hex, "witness.tx_hash_be_hex");
  assertHex64(witness.commitment_be_hex, "witness.commitment_be_hex");
  assertHex64(witness.pubkeys_hash_be_hex, "witness.pubkeys_hash_be_hex");
  for (let i = 0; i < witness.path_elements_be_hex.length; i++) {
    assertHex64(
      witness.path_elements_be_hex[i],
      `witness.path_elements_be_hex[${i}]`
    );
  }

  assertDecimalString(witness.denomination, "witness.denomination");
  assertDecimalString(witness.fee, "witness.fee");
  assertDecimalString(witness.chain_id, "witness.chain_id");
  assertDecimalString(witness.expiry_slot, "witness.expiry_slot");
  assertDecimalString(witness.circuit_version, "witness.circuit_version");

  if (witness.circuit_version !== DEFAULT_CIRCUIT_VERSION.toString()) {
    throw new Error(
      `buildWithdrawSolV1CircomInputJson: witness.circuit_version must be ` +
        `"${DEFAULT_CIRCUIT_VERSION.toString()}", got ${JSON.stringify(
          witness.circuit_version
        )}`
    );
  }

  const recomputedNullifierHash = computeNullifierHash(secret);
  if (recomputedNullifierHash !== witness.nullifier_hash_be_hex) {
    throw new Error(
      "buildWithdrawSolV1CircomInputJson: computeNullifierHash(secret) does not match " +
        "witness.nullifier_hash_be_hex. Verify secret is correct for this note."
    );
  }

  const denominationBigInt = BigInt(witness.denomination);
  const recomputedCommitment = computeNoteCommitment(
    secret,
    denominationBigInt
  );
  if (recomputedCommitment !== witness.commitment_be_hex) {
    throw new Error(
      "buildWithdrawSolV1CircomInputJson: computeNoteCommitment(secret, denomination) " +
        "does not match witness.commitment_be_hex. Verify secret and denomination."
    );
  }

  const recomputedPubkeysHash = computePubkeysHash(
    accounts.programId,
    accounts.poolPda,
    accounts.configPda,
    accounts.recipient,
    accounts.relayer
  );
  if (recomputedPubkeysHash !== witness.pubkeys_hash_be_hex) {
    throw new Error(
      "buildWithdrawSolV1CircomInputJson: accounts pubkeys_hash does not match " +
        "witness.pubkeys_hash_be_hex. Verify that the same accounts used to build " +
        "the WitnessJson are passed here."
    );
  }

  const recomputedTxHash = computeTxHash(
    recomputedPubkeysHash,
    denominationBigInt,
    BigInt(witness.fee),
    BigInt(witness.chain_id),
    BigInt(witness.expiry_slot),
    BigInt(witness.circuit_version)
  );
  if (recomputedTxHash !== witness.tx_hash_be_hex) {
    throw new Error(
      "buildWithdrawSolV1CircomInputJson: recomputed tx_hash does not match " +
        "witness.tx_hash_be_hex. Verify denomination, fee, chain_id, expiry_slot, " +
        "circuit_version, and accounts are consistent with the WitnessJson."
    );
  }

  const pid = splitPubkey(accounts.programId);
  const pool = splitPubkey(accounts.poolPda);
  const cfg = splitPubkey(accounts.configPda);
  const rec = splitPubkey(accounts.recipient);
  const rel = splitPubkey(accounts.relayer);

  return {
    root: BigInt("0x" + witness.root_be_hex).toString(),
    nullifier_hash: BigInt("0x" + witness.nullifier_hash_be_hex).toString(),
    tx_hash: BigInt("0x" + witness.tx_hash_be_hex).toString(),

    secret: secret.toString(),
    denomination: witness.denomination,

    path_elements: witness.path_elements_be_hex.map((h) =>
      BigInt("0x" + h).toString()
    ),
    path_indices: witness.path_indices.map((v) => v.toString()),

    program_id_lo: pid.lo.toString(),
    program_id_hi: pid.hi.toString(),
    pool_pda_lo: pool.lo.toString(),
    pool_pda_hi: pool.hi.toString(),
    config_pda_lo: cfg.lo.toString(),
    config_pda_hi: cfg.hi.toString(),
    recipient_lo: rec.lo.toString(),
    recipient_hi: rec.hi.toString(),
    relayer_lo: rel.lo.toString(),
    relayer_hi: rel.hi.toString(),

    fee: witness.fee,
    chain_id: witness.chain_id,
    expiry_slot: witness.expiry_slot,
    circuit_version: witness.circuit_version,
  };
}
