// This module handles snarkjs Groth16 proof JSON -> withdraw_zk byte encoding only.
// It does not verify cryptographic proof validity.
// It does not check whether points are on-curve.
// It validates shape, decimal field membership, byte order, and serialization only.

import * as fs from "fs";
import type { ZkProofJson } from "./fixture";

// ── Constants ─────────────────────────────────────────────────────────────────

// BN254 base field modulus (Fq).
// Used for G1/G2 proof coordinate validation and proof_a.y negation.
// Do not use this for public input validation — public inputs use Fr (BN254_FR_MODULUS_DEC).
export const BN254_FQ_MODULUS_DEC =
  "21888242871839275222246405745257275088696311157297823662689037894645226208583";

// BN254 scalar field modulus (Fr).
// Used for public inputs (root, nullifier_hash, tx_hash).
// Must NOT be used for proof coordinate negation — proof coordinates use Fq, not Fr.
export const BN254_FR_MODULUS_DEC =
  "21888242871839275217838404197654757664998891166987897764917837483962643527169";

const BN254_FQ = BigInt(BN254_FQ_MODULUS_DEC);

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface EncodedGroth16Proof {
  proofA: number[];
  proofB: number[];
  proofC: number[];
}

// ── Primitives ────────────────────────────────────────────────────────────────

/**
 * Parse a decimal string to BigInt. Accepts only /^[0-9]+$/.
 * Rejects empty strings, whitespace, negative signs, decimal points, and hex prefixes.
 */
export function decimalStringToBigIntStrict(value: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(
      `decimalStringToBigIntStrict: expected a non-empty decimal string, got ${JSON.stringify(
        value
      )}`
    );
  }
  return BigInt(value);
}

/**
 * Serialize a BigInt to exactly 32 bytes, big-endian (most significant byte first).
 * bigintToBytes32BE(1n) places 1 in the last (index 31) byte.
 * Throws if value < 0 or value >= 2^256.
 */
export function bigintToBytes32BE(value: bigint): number[] {
  if (value < 0n) {
    throw new Error(
      `bigintToBytes32BE: value must be non-negative, got ${value}`
    );
  }
  if (value >= 2n ** 256n) {
    throw new Error(
      `bigintToBytes32BE: value ${value} exceeds 32-byte maximum (2^256 - 1)`
    );
  }
  const out = new Array<number>(32).fill(0);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Validate a BigInt is a canonical BN254 Fq field element: 0 <= value < Fq.
 * Returns the value on success; throws with the fieldName in the error message.
 */
export function validateFq(value: bigint, fieldName: string): bigint {
  if (value < 0n) {
    throw new Error(
      `${fieldName}: BN254 Fq element must be non-negative, got ${value}`
    );
  }
  if (value >= BN254_FQ) {
    throw new Error(`${fieldName}: value ${value} exceeds BN254 Fq modulus`);
  }
  return value;
}

/**
 * Negate a BN254 Fq element.
 * negateFq(0n) === 0n.
 * negateFq(y) === BN254_FQ - y for y > 0.
 * Throws if value is not a canonical Fq element.
 */
export function negateFq(value: bigint): bigint {
  validateFq(value, "negateFq(value)");
  if (value === 0n) return 0n;
  return BN254_FQ - value;
}

// ── Internal validation helpers ───────────────────────────────────────────────

function assertObject(
  value: unknown,
  context: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${context}: expected an object, got ${JSON.stringify(value)}`
    );
  }
  return value as Record<string, unknown>;
}

function assertStringTriple(
  value: unknown,
  context: string
): [string, string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string" ||
    typeof value[2] !== "string"
  ) {
    throw new Error(
      `${context}: expected [string, string, string], got ${JSON.stringify(
        value
      )}`
    );
  }
  return value as [string, string, string];
}

function assertFp2Pair(value: unknown, context: string): [string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new Error(
      `${context}: expected [string, string], got ${JSON.stringify(value)}`
    );
  }
  return value as [string, string];
}

function assertG2Point(
  value: unknown,
  context: string
): [[string, string], [string, string], [string, string]] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(
      `${context}: expected array of length 3, got ${JSON.stringify(value)}`
    );
  }
  const x = assertFp2Pair(value[0], `${context}[0]`);
  const y = assertFp2Pair(value[1], `${context}[1]`);
  const z = assertFp2Pair(value[2], `${context}[2]`);
  return [x, y, z];
}

function parseFqCoord(dec: string, fieldName: string): bigint {
  const v = decimalStringToBigIntStrict(dec);
  return validateFq(v, fieldName);
}

// ── Main encoder ──────────────────────────────────────────────────────────────

/**
 * Encode a snarkjs Groth16 proof JSON into byte arrays for the withdraw_zk instruction.
 *
 * Returns:
 *   proofA: 64 bytes  = x_BE(32) || negateFq(y)_BE(32)
 *   proofB: 128 bytes = x.c1_BE(32) || x.c0_BE(32) || y.c1_BE(32) || y.c0_BE(32)
 *   proofC: 64 bytes  = x_BE(32) || y_BE(32)
 *
 * Where snarkjs pi_b[i] = [c0_dec, c1_dec] (real part first, imaginary second),
 * and groth16-solana / EIP-197 expects imaginary (c1) first, then real (c0).
 *
 * NOTE: proof_b coordinate order is source-backed by groth16-solana 0.2.0:
 *   - groth16.rs PROOF constant + proof_verification_should_succeed test confirm the
 *     PROOF[64..192] layout used by Groth16Verifier::new.
 *   - decompression.rs apply_bitmask test confirms G2 round-trip via
 *     convert_endianness::<64,128> (reverses each 64-byte Fq2 pair) + G2::deserialize,
 *     proving PROOF[64..192] = x.c1_BE(32)||x.c0_BE(32)||y.c1_BE(32)||y.c0_BE(32).
 *   - parse_vk_to_rust.js VK G2 conversion: snarkjs [c0,c1] → c1_BE||c0_BE per
 *     Fq2 pair (same layout as proof_b, consistent with alt_bn128_pairing input).
 * End-to-end verification against real WITHDRAW_SOL_V1 circuit output is still
 * required before production reliance.
 *
 * Validates: proof shape, protocol, curve, projective z-coordinates, decimal encoding,
 * and BN254 Fq field membership for all proof coordinates.
 * Does NOT check point-on-curve or cryptographic proof validity.
 */
export function encodeSnarkjsGroth16Proof(
  proof: ZkProofJson
): EncodedGroth16Proof {
  const obj = assertObject(proof, "proof");

  // Protocol and curve
  if (obj["protocol"] !== "groth16") {
    throw new Error(
      `proof.protocol: expected "groth16", got ${JSON.stringify(
        obj["protocol"]
      )}`
    );
  }
  if (obj["curve"] !== "bn128") {
    throw new Error(
      `proof.curve: expected "bn128", got ${JSON.stringify(obj["curve"])}`
    );
  }

  // Shape validation
  const piA = assertStringTriple(obj["pi_a"], "proof.pi_a");
  const piB = assertG2Point(obj["pi_b"], "proof.pi_b");
  const piC = assertStringTriple(obj["pi_c"], "proof.pi_c");

  // Projective z-coordinate checks
  if (piA[2] !== "1") {
    throw new Error(
      `proof.pi_a[2]: projective z must be "1", got ${JSON.stringify(piA[2])}`
    );
  }
  if (piB[2][0] !== "1" || piB[2][1] !== "0") {
    throw new Error(
      `proof.pi_b[2]: projective z must be ["1", "0"], got ${JSON.stringify(
        piB[2]
      )}`
    );
  }
  if (piC[2] !== "1") {
    throw new Error(
      `proof.pi_c[2]: projective z must be "1", got ${JSON.stringify(piC[2])}`
    );
  }

  // Parse proof_a: G1 = (x, y), output x_BE || negateFq(y)_BE
  const aX = parseFqCoord(piA[0], "pi_a[0]");
  const aY = parseFqCoord(piA[1], "pi_a[1]");

  // Parse proof_b: G2 = (x, y) where x,y ∈ Fq2, each = [c0, c1] in snarkjs
  // groth16-solana / EIP-197 layout: c1 before c0 per coordinate
  const bXc0 = parseFqCoord(piB[0][0], "pi_b[0][0]");
  const bXc1 = parseFqCoord(piB[0][1], "pi_b[0][1]");
  const bYc0 = parseFqCoord(piB[1][0], "pi_b[1][0]");
  const bYc1 = parseFqCoord(piB[1][1], "pi_b[1][1]");

  // Parse proof_c: G1 = (x, y), output x_BE || y_BE (no negation)
  const cX = parseFqCoord(piC[0], "pi_c[0]");
  const cY = parseFqCoord(piC[1], "pi_c[1]");

  const proofA: number[] = [
    ...bigintToBytes32BE(aX),
    ...bigintToBytes32BE(negateFq(aY)),
  ];

  // Source-backed by groth16-solana 0.2.0 PROOF layout, decompression round-trip,
  // and parse_vk_to_rust.js VK G2 conversion. End-to-end verification with real
  // WITHDRAW_SOL_V1 circuit output is still required.
  const proofB: number[] = [
    ...bigintToBytes32BE(bXc1), // x.c1 (imaginary part, EIP-197 first)
    ...bigintToBytes32BE(bXc0), // x.c0 (real part)
    ...bigintToBytes32BE(bYc1), // y.c1 (imaginary part)
    ...bigintToBytes32BE(bYc0), // y.c0 (real part)
  ];

  const proofC: number[] = [...bigintToBytes32BE(cX), ...bigintToBytes32BE(cY)];

  if (proofA.length !== 64) {
    throw new Error(`internal: proofA length ${proofA.length} !== 64`);
  }
  if (proofB.length !== 128) {
    throw new Error(`internal: proofB length ${proofB.length} !== 128`);
  }
  if (proofC.length !== 64) {
    throw new Error(`internal: proofC length ${proofC.length} !== 64`);
  }

  return { proofA, proofB, proofC };
}

/**
 * Load a snarkjs proof JSON file and encode it.
 * Throws on file read error, JSON parse error, or validation failure.
 */
export function loadAndEncodeSnarkjsGroth16Proof(
  path: string
): EncodedGroth16Proof {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `loadAndEncodeSnarkjsGroth16Proof: cannot read ${path}: ${msg}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `loadAndEncodeSnarkjsGroth16Proof: invalid JSON in ${path}: ${msg}`
    );
  }
  return encodeSnarkjsGroth16Proof(parsed as ZkProofJson);
}
