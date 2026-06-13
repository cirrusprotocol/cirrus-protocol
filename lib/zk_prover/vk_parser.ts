// Validates and encodes a snarkjs Groth16 verification_key.json shape into the
// byte layout expected by groth16-solana::groth16::Groth16Verifyingkey.
//
// Shape/serialization only. Does NOT verify cryptographic validity, does NOT
// check whether VK points are on-curve, and does NOT require real proving keys.
//
// G1 encoding: x_BE(32) || y_BE(32)  — no y-negation (unlike proof_a)
// G2 encoding: x.c1_BE(32) || x.c0_BE(32) || y.c1_BE(32) || y.c0_BE(32)
//   snarkjs emits Fq2 as [c0, c1] (real part first); groth16-solana / EIP-197
//   expects c1 || c0 (imaginary first). Same layout as proof_b in proof_encoder.ts.
//
// Source-backed by groth16-solana 0.2.0 parse_vk_to_rust.js: for G2, each
// coordinate pair [c0,c1] is converted as leInt2Buff(c0)||leInt2Buff(c1) then
// .reverse(), yielding c1_BE||c0_BE per coordinate.
//
// nrPubinputs mirrors Groth16Verifyingkey.nr_pubinputs = IC.length = nPublic + 1.
// For WITHDRAW_SOL_V1 (3 public inputs), nrPubinputs = 4.

import * as fs from "fs";
import {
  bigintToBytes32BE,
  decimalStringToBigIntStrict,
  validateFq,
} from "./proof_encoder";

// ── Constants ─────────────────────────────────────────────────────────────────

// WITHDRAW_SOL_V1 public input count: [root, nullifier_hash, tx_hash].
// Matches WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT in zk_verifier.rs.
export const WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT = 3;

// IC length = public_input_count + 1 (constant term).
// Groth16Verifier::new enforces: vk_ic.len() == public_inputs.len() + 1.
export const WITHDRAW_SOL_V1_VK_IC_LENGTH = 4;

// ── Interfaces ────────────────────────────────────────────────────────────────

// snarkjs verification_key.json shape for groth16/bn128.
// Field names match snarkjs output exactly. vk_gamma_2 is the correct snarkjs
// spelling; the Rust crate field name vk_gamme_g2 is a different (typo) name.
export interface SnarkjsGroth16VerificationKeyJson {
  protocol: "groth16";
  curve: "bn128";
  nPublic: number;
  vk_alpha_1: [string, string, string];
  vk_beta_2: [[string, string], [string, string], [string, string]];
  vk_gamma_2: [[string, string], [string, string], [string, string]];
  vk_delta_2: [[string, string], [string, string], [string, string]];
  IC: [string, string, string][];
}

// Encoded VK layout mirroring groth16_solana::groth16::Groth16Verifyingkey.
// Field names use camelCase; vkGammeG2 deliberately uses the crate's typo
// spelling to make the mismatch with snarkjs vk_gamma_2 visible.
export interface EncodedGroth16VerifyingKey {
  nrPubinputs: number; // = IC.length = nPublic + 1
  vkAlphaG1: number[]; // 64 bytes: x_BE || y_BE
  vkBetaG2: number[]; // 128 bytes: x.c1_BE || x.c0_BE || y.c1_BE || y.c0_BE
  vkGammeG2: number[]; // 128 bytes; intentional "Gamme" mirrors crate field typo
  vkDeltaG2: number[]; // 128 bytes: x.c1_BE || x.c0_BE || y.c1_BE || y.c0_BE
  vkIc: number[][]; // each 64 bytes; length = nrPubinputs
}

// ── Internal shape validators ─────────────────────────────────────────────────

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

// ── Public encoding functions ─────────────────────────────────────────────────

/**
 * Encode a snarkjs G1 point [x_dec, y_dec, z_dec] into 64 bytes: x_BE || y_BE.
 *
 * No y-negation is applied (unlike proof_a encoding in proof_encoder.ts).
 * VK G1 points are not negated.
 */
export function encodeSnarkjsG1Point(
  point: unknown,
  fieldName: string
): number[] {
  const triple = assertStringTriple(point, fieldName);
  if (triple[2] !== "1") {
    throw new Error(
      `${fieldName}[2]: projective z must be "1", got ${JSON.stringify(
        triple[2]
      )}`
    );
  }
  const x = parseFqCoord(triple[0], `${fieldName}[0]`);
  const y = parseFqCoord(triple[1], `${fieldName}[1]`);
  const result = [...bigintToBytes32BE(x), ...bigintToBytes32BE(y)];
  if (result.length !== 64) {
    throw new Error(`internal: G1 length ${result.length} !== 64`);
  }
  return result;
}

/**
 * Encode a snarkjs G2 point [[x_c0,x_c1],[y_c0,y_c1],[z_c0,z_c1]] into 128 bytes:
 * x.c1_BE(32) || x.c0_BE(32) || y.c1_BE(32) || y.c0_BE(32).
 *
 * snarkjs emits Fq2 coordinates as [c0, c1] (real first, imaginary second).
 * groth16-solana / EIP-197 expects imaginary (c1) before real (c0).
 * Same byte order as proof_b in proof_encoder.ts.
 */
export function encodeSnarkjsG2Point(
  point: unknown,
  fieldName: string
): number[] {
  const [xPair, yPair, zPair] = assertG2Point(point, fieldName);
  if (zPair[0] !== "1" || zPair[1] !== "0") {
    throw new Error(
      `${fieldName}[2]: projective z must be ["1","0"], got ${JSON.stringify(
        zPair
      )}`
    );
  }
  const xC0 = parseFqCoord(xPair[0], `${fieldName}[0][0]`);
  const xC1 = parseFqCoord(xPair[1], `${fieldName}[0][1]`);
  const yC0 = parseFqCoord(yPair[0], `${fieldName}[1][0]`);
  const yC1 = parseFqCoord(yPair[1], `${fieldName}[1][1]`);
  // G2 layout: x.c1_BE || x.c0_BE || y.c1_BE || y.c0_BE
  const result = [
    ...bigintToBytes32BE(xC1),
    ...bigintToBytes32BE(xC0),
    ...bigintToBytes32BE(yC1),
    ...bigintToBytes32BE(yC0),
  ];
  if (result.length !== 128) {
    throw new Error(`internal: G2 length ${result.length} !== 128`);
  }
  return result;
}

/**
 * Encode a snarkjs Groth16 verification key JSON into the byte layout expected
 * by groth16-solana::groth16::Groth16Verifyingkey.
 *
 * Validates:
 * - protocol === "groth16"
 * - curve === "bn128"
 * - nPublic === WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT (3)
 * - IC.length === WITHDRAW_SOL_V1_VK_IC_LENGTH (4)
 * - all G1/G2 point shapes and BN254 Fq field membership
 *
 * Returns nrPubinputs = 4 = IC.length = nPublic + 1.
 */
export function encodeSnarkjsGroth16VerificationKey(
  vk: SnarkjsGroth16VerificationKeyJson
): EncodedGroth16VerifyingKey {
  if (typeof vk !== "object" || vk === null || Array.isArray(vk)) {
    throw new Error(`vk: expected an object, got ${JSON.stringify(vk)}`);
  }
  const obj = vk as unknown as Record<string, unknown>;

  if (obj["protocol"] !== "groth16") {
    throw new Error(
      `vk.protocol: expected "groth16", got ${JSON.stringify(obj["protocol"])}`
    );
  }
  if (obj["curve"] !== "bn128") {
    throw new Error(
      `vk.curve: expected "bn128", got ${JSON.stringify(obj["curve"])}`
    );
  }
  if (obj["nPublic"] !== WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT) {
    throw new Error(
      `vk.nPublic: expected ${WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT}, got ${JSON.stringify(
        obj["nPublic"]
      )}`
    );
  }

  const ic = obj["IC"];
  if (!Array.isArray(ic) || ic.length !== WITHDRAW_SOL_V1_VK_IC_LENGTH) {
    throw new Error(
      `vk.IC: expected array of length ${WITHDRAW_SOL_V1_VK_IC_LENGTH}, got ${
        Array.isArray(ic) ? ic.length : JSON.stringify(ic)
      }`
    );
  }

  const vkAlphaG1 = encodeSnarkjsG1Point(obj["vk_alpha_1"], "vk.vk_alpha_1");
  const vkBetaG2 = encodeSnarkjsG2Point(obj["vk_beta_2"], "vk.vk_beta_2");
  const vkGammeG2 = encodeSnarkjsG2Point(obj["vk_gamma_2"], "vk.vk_gamma_2");
  const vkDeltaG2 = encodeSnarkjsG2Point(obj["vk_delta_2"], "vk.vk_delta_2");
  const vkIc = ic.map((item: unknown, i: number) =>
    encodeSnarkjsG1Point(item, `vk.IC[${i}]`)
  );

  return {
    nrPubinputs: WITHDRAW_SOL_V1_VK_IC_LENGTH,
    vkAlphaG1,
    vkBetaG2,
    vkGammeG2,
    vkDeltaG2,
    vkIc,
  };
}

/**
 * Load a snarkjs verification_key.json file and encode it.
 * Throws on file read error, JSON parse error, or validation failure.
 */
export function loadAndEncodeSnarkjsGroth16VerificationKey(
  path: string
): EncodedGroth16VerifyingKey {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `loadAndEncodeSnarkjsGroth16VerificationKey: cannot read ${path}: ${msg}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `loadAndEncodeSnarkjsGroth16VerificationKey: invalid JSON in ${path}: ${msg}`
    );
  }
  return encodeSnarkjsGroth16VerificationKey(
    parsed as SnarkjsGroth16VerificationKeyJson
  );
}

// ── Rust preview formatters (shape preview only, not for committed output) ────

/**
 * Format a byte array as a Rust [u8; N] literal string.
 * For shape preview only — do not use to generate committed Rust VK files.
 */
export function formatRustU8Array(bytes: number[]): string {
  return `[${bytes.join(", ")}]`;
}

/**
 * Format an encoded VK as a Groth16Verifyingkey struct literal preview.
 *
 * The output uses the exact Rust crate field names, including the intentional
 * crate typo vk_gamme_g2 (not vk_gamma_g2). Do not write this output to a
 * committed .rs file directly — the VK constant must be generated from a
 * reviewed verification_key.json and committed in a dedicated PR.
 */
export function formatRustVkPreview(vk: EncodedGroth16VerifyingKey): string {
  const lines: string[] = [];
  lines.push(`Groth16Verifyingkey {`);
  lines.push(`    nr_pubinputs: ${vk.nrPubinputs},`);
  lines.push(`    vk_alpha_g1: ${formatRustU8Array(vk.vkAlphaG1)},`);
  lines.push(`    vk_beta_g2: ${formatRustU8Array(vk.vkBetaG2)},`);
  lines.push(`    vk_gamme_g2: ${formatRustU8Array(vk.vkGammeG2)},`);
  lines.push(`    vk_delta_g2: ${formatRustU8Array(vk.vkDeltaG2)},`);
  lines.push(`    vk_ic: &VK_IC,`);
  lines.push(`}`);
  return lines.join("\n");
}
