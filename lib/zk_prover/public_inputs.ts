// Normalizes snarkjs public.json decimal-string output for comparison against
// the committed public_test_vector.json.
//
// snarkjs groth16 prove outputs public.json as a JSON array of decimal strings:
//   ["<root_dec>", "<nullifier_hash_dec>", "<tx_hash_dec>"]
//
// public_test_vector.json stores expected values as 64-char lowercase big-endian hex.
//
// This module converts decimal strings to 64-char BE hex and compares them.
// It does NOT verify cryptographic proof validity.
// It only checks order, format, and value match against the test vector.

import * as fs from "fs";
import { decimalStringToBigIntStrict } from "./proof_encoder";

// ── Constants ─────────────────────────────────────────────────────────────────

export const WITHDRAW_SOL_V1_PUBLIC_INPUTS_ORDER = [
  "root",
  "nullifier_hash",
  "tx_hash",
] as const;

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface NormalizedPublicInputs {
  root_be_hex: string;
  nullifier_hash_be_hex: string;
  tx_hash_be_hex: string;
}

export interface PublicInputComparison {
  ok: boolean;
  expected: NormalizedPublicInputs;
  actual: NormalizedPublicInputs;
  mismatches: string[];
}

// ── Primitives ────────────────────────────────────────────────────────────────

/**
 * Serialize a BigInt to exactly 64 lowercase hex chars, no 0x prefix.
 * Throws for negative values or values >= 2^256.
 */
export function bigintToHex32BE(value: bigint): string {
  if (value < 0n) {
    throw new Error(
      `bigintToHex32BE: value must be non-negative, got ${value}`
    );
  }
  if (value >= 2n ** 256n) {
    throw new Error(
      `bigintToHex32BE: value ${value} exceeds 32-byte maximum (2^256 - 1)`
    );
  }
  return value.toString(16).padStart(64, "0");
}

/**
 * Parse a strict decimal string and return 64-char lowercase BE hex.
 */
export function decimalStringToHex32BE(value: string): string {
  const v = decimalStringToBigIntStrict(value);
  return bigintToHex32BE(v);
}

// ── Core normalizer ───────────────────────────────────────────────────────────

/**
 * Normalize a snarkjs public.json value (array of 3 decimal strings) to
 * NormalizedPublicInputs with 64-char lowercase BE hex fields.
 *
 * Expected input shape: ["<root_dec>", "<nullifier_hash_dec>", "<tx_hash_dec>"]
 * All elements must be strict non-negative decimal strings.
 */
export function normalizeSnarkjsPublicJson(
  publicJson: unknown
): NormalizedPublicInputs {
  if (!Array.isArray(publicJson)) {
    throw new Error(
      `normalizeSnarkjsPublicJson: expected an array, got ${JSON.stringify(
        publicJson
      )}`
    );
  }
  if (publicJson.length !== 3) {
    throw new Error(
      `normalizeSnarkjsPublicJson: expected array length 3, got ${publicJson.length}`
    );
  }
  for (let i = 0; i < 3; i++) {
    if (typeof publicJson[i] !== "string") {
      throw new Error(
        `normalizeSnarkjsPublicJson: element [${i}] must be a string, got ${JSON.stringify(
          publicJson[i]
        )}`
      );
    }
  }
  return {
    root_be_hex: decimalStringToHex32BE(publicJson[0] as string),
    nullifier_hash_be_hex: decimalStringToHex32BE(publicJson[1] as string),
    tx_hash_be_hex: decimalStringToHex32BE(publicJson[2] as string),
  };
}

// ── File loaders ──────────────────────────────────────────────────────────────

/**
 * Read and JSON-parse a public.json file.
 * Throws on file read error or JSON parse error.
 */
export function loadSnarkjsPublicJson(path: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`loadSnarkjsPublicJson: cannot read ${path}: ${msg}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`loadSnarkjsPublicJson: invalid JSON in ${path}: ${msg}`);
  }
}

/**
 * Load and normalize a snarkjs public.json file.
 * Throws on file read, parse, or validation error.
 */
export function loadAndNormalizeSnarkjsPublicJson(
  path: string
): NormalizedPublicInputs {
  return normalizeSnarkjsPublicJson(loadSnarkjsPublicJson(path));
}

// ── Comparison ────────────────────────────────────────────────────────────────

/**
 * Compare a normalized public.json against a public_test_vector.json shape.
 *
 * Returns ok: true if all three fields match.
 * Returns ok: false with mismatches listed if any field differs.
 * Throws if expectedVector.public_inputs_order is not exactly
 * ["root", "nullifier_hash", "tx_hash"].
 */
export function comparePublicInputsToVector(
  actual: NormalizedPublicInputs,
  expectedVector: {
    public_inputs_order: string[];
    root_be_hex: string;
    nullifier_hash_be_hex: string;
    tx_hash_be_hex: string;
  }
): PublicInputComparison {
  const expected_order =
    WITHDRAW_SOL_V1_PUBLIC_INPUTS_ORDER as readonly string[];
  const actual_order = expectedVector.public_inputs_order;
  if (
    !Array.isArray(actual_order) ||
    actual_order.length !== 3 ||
    actual_order[0] !== expected_order[0] ||
    actual_order[1] !== expected_order[1] ||
    actual_order[2] !== expected_order[2]
  ) {
    throw new Error(
      `comparePublicInputsToVector: expectedVector.public_inputs_order must be ` +
        `["root", "nullifier_hash", "tx_hash"], got ${JSON.stringify(
          actual_order
        )}`
    );
  }

  const expected: NormalizedPublicInputs = {
    root_be_hex: expectedVector.root_be_hex,
    nullifier_hash_be_hex: expectedVector.nullifier_hash_be_hex,
    tx_hash_be_hex: expectedVector.tx_hash_be_hex,
  };

  const mismatches: string[] = [];
  if (actual.root_be_hex !== expected.root_be_hex) {
    mismatches.push("root_be_hex");
  }
  if (actual.nullifier_hash_be_hex !== expected.nullifier_hash_be_hex) {
    mismatches.push("nullifier_hash_be_hex");
  }
  if (actual.tx_hash_be_hex !== expected.tx_hash_be_hex) {
    mismatches.push("tx_hash_be_hex");
  }

  return {
    ok: mismatches.length === 0,
    expected,
    actual,
    mismatches,
  };
}

/**
 * Load public.json and public_test_vector.json from disk and compare.
 * Throws on file read/parse/validation errors or malformed vector order.
 */
export function loadAndComparePublicInputs(
  publicJsonPath: string,
  vectorPath: string
): PublicInputComparison {
  const actual = loadAndNormalizeSnarkjsPublicJson(publicJsonPath);

  let rawVector: unknown;
  try {
    rawVector = JSON.parse(fs.readFileSync(vectorPath, "utf8"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `loadAndComparePublicInputs: cannot load vector ${vectorPath}: ${msg}`
    );
  }

  const vec = rawVector as {
    public_inputs_order: string[];
    root_be_hex: string;
    nullifier_hash_be_hex: string;
    tx_hash_be_hex: string;
  };

  return comparePublicInputsToVector(actual, vec);
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/**
 * Format a PublicInputComparison result as a human-readable string.
 * Prints PASS or FAIL, expected/actual values, and mismatch names.
 */
export function formatPublicInputComparison(
  result: PublicInputComparison
): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push("PASS — public inputs match test vector");
    lines.push(`  root_be_hex:           ${result.actual.root_be_hex}`);
    lines.push(
      `  nullifier_hash_be_hex: ${result.actual.nullifier_hash_be_hex}`
    );
    lines.push(`  tx_hash_be_hex:        ${result.actual.tx_hash_be_hex}`);
  } else {
    lines.push("FAIL — public inputs do not match test vector");
    lines.push(`  mismatches: ${result.mismatches.join(", ")}`);
    for (const field of result.mismatches) {
      const f = field as keyof NormalizedPublicInputs;
      lines.push(`  ${field}:`);
      lines.push(`    expected: ${result.expected[f]}`);
      lines.push(`    actual:   ${result.actual[f]}`);
    }
  }
  return lines.join("\n");
}
