// Pure helpers for parsing withdraw_zk artifact JSON into normalized scalars.
// No filesystem, network, RPC, keypair, or Anchor provider usage.

import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { bigintToHex32BE, normalizeSnarkjsPublicJson } from "./public_inputs";
import { decimalStringToBigIntStrict } from "./proof_encoder";

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface WithdrawZkPublicInputs {
  rootBeHex: string;
  nullifierHashBeHex: string;
  txHashBeHex: string;
}

export interface WithdrawZkInputScalars {
  denomination?: string;
  fee?: string;
  expirySlot?: string;
  circuitVersion?: string;
  txHash?: string;
}

export interface WithdrawZkConsistency {
  ok: boolean;
  mismatches: string[];
}

// ── Normalizer ──────────────────────────────────────────────────────────────

/**
 * Normalize a hex or strict non-negative decimal string to 64-char lowercase
 * big-endian hex (no 0x prefix). Precedence resolves the ambiguity of an
 * all-digit 64-char value:
 *   1. 0x/0X prefix -> exactly 64 hex chars after the prefix, lowercased.
 *   2. No prefix, all digits -> decimal (so a 64-digit decimal is NOT treated
 *      as bare hex).
 *   3. No prefix, 64 hex chars containing a-f/A-F -> bare hex, lowercased.
 *   4. Otherwise throw.
 * Throws for invalid input or values >= 2^256.
 */
export function normalizeHexOrDecimalToHex32(
  value: string,
  label: string
): string {
  if (typeof value !== "string") {
    throw new Error(
      `${label}: expected a string, got ${JSON.stringify(value)}`
    );
  }
  if (value.startsWith("0x") || value.startsWith("0X")) {
    const hexBody = value.slice(2);
    if (/^[0-9a-fA-F]{64}$/.test(hexBody)) {
      return hexBody.toLowerCase();
    }
    throw new Error(
      `${label}: expected exactly 64 hex chars after 0x prefix, got ${JSON.stringify(
        value
      )}`
    );
  }
  if (/^[0-9]+$/.test(value)) {
    return bigintToHex32BE(decimalStringToBigIntStrict(value));
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return value.toLowerCase();
  }
  throw new Error(
    `${label}: expected 0x+64 hex, 64 hex chars, or a decimal string, got ${JSON.stringify(
      value
    )}`
  );
}

// ── Parsers ─────────────────────────────────────────────────────────────────

/**
 * Parse a snarkjs public.json value into camelCase withdraw_zk public inputs.
 */
export function parseWithdrawZkPublicInputs(
  raw: unknown
): WithdrawZkPublicInputs {
  const normalized = normalizeSnarkjsPublicJson(raw);
  return {
    rootBeHex: normalized.root_be_hex,
    nullifierHashBeHex: normalized.nullifier_hash_be_hex,
    txHashBeHex: normalized.tx_hash_be_hex,
  };
}

/**
 * Parse an object of optional withdraw_zk input scalars. Recognized fields
 * must be strings if present; unrecognized fields are ignored.
 */
export function parseWithdrawZkInputScalars(
  raw: unknown
): WithdrawZkInputScalars {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `parseWithdrawZkInputScalars: expected an object, got ${JSON.stringify(
        raw
      )}`
    );
  }
  const obj = raw as Record<string, unknown>;
  const out: WithdrawZkInputScalars = {};
  const fields: [string, keyof WithdrawZkInputScalars][] = [
    ["denomination", "denomination"],
    ["fee", "fee"],
    ["expiry_slot", "expirySlot"],
    ["circuit_version", "circuitVersion"],
    ["tx_hash", "txHash"],
  ];
  for (const [key, prop] of fields) {
    if (key in obj && obj[key] !== undefined) {
      const v = obj[key];
      if (typeof v !== "string") {
        throw new Error(
          `parseWithdrawZkInputScalars: field "${key}" must be a string, got ${JSON.stringify(
            v
          )}`
        );
      }
      out[prop] = v;
    }
  }
  return out;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Cross-check parsed input scalars against parsed public inputs.
 * The only field shared between the two structures is tx_hash: when
 * scalars.txHash is present, it must normalize to the same 64-char BE hex as
 * publicInputs.txHashBeHex. Returns ok: true with an empty mismatches list when
 * consistent (including when scalars.txHash is absent).
 */
export function validateWithdrawZkScalarsAgainstPublicInputs(
  scalars: WithdrawZkInputScalars,
  publicInputs: WithdrawZkPublicInputs
): WithdrawZkConsistency {
  const mismatches: string[] = [];
  if (scalars.txHash !== undefined) {
    const normalized = normalizeHexOrDecimalToHex32(scalars.txHash, "tx_hash");
    if (normalized !== publicInputs.txHashBeHex) {
      mismatches.push("tx_hash");
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// ── PDA derivation ────────────────────────────────────────────────────────────

export function deriveWithdrawZkPoolStatePda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    programId
  );
}

export function deriveWithdrawZkVerifierConfigPda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verifier_config")],
    programId
  );
}

export function deriveWithdrawZkNullifierMarkerPda(
  programId: PublicKey,
  nullifierHashBeHex: string
): [PublicKey, number] {
  if (!/^[0-9a-fA-F]{64}$/.test(nullifierHashBeHex)) {
    throw new Error(
      `deriveWithdrawZkNullifierMarkerPda: nullifierHashBeHex must be exactly 64 hex chars, got ${JSON.stringify(
        nullifierHashBeHex
      )}`
    );
  }
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("nullifier"),
      Buffer.from(nullifierHashBeHex.toLowerCase(), "hex"),
    ],
    programId
  );
}

// ── Artifact path warnings ────────────────────────────────────────────────────

const RAW_ARTIFACT_BASENAMES = new Set([
  "proof.json",
  "public.json",
  "input.json",
  "verification_key.json",
  "metadata.json",
]);

const RAW_ARTIFACT_EXTENSIONS = new Set([
  ".ptau",
  ".r1cs",
  ".wasm",
  ".sym",
  ".wtns",
  ".zkey",
]);

function isInsideRepo(abs: string, normalizedRoot: string): boolean {
  const rel = path.relative(normalizedRoot, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isRawArtifact(base: string): boolean {
  if (RAW_ARTIFACT_BASENAMES.has(base)) return true;
  const ext = path.extname(base);
  return RAW_ARTIFACT_EXTENSIONS.has(ext);
}

/**
 * Return warning strings for any artifact path that is inside the repository
 * and looks like a raw ZK artifact. Safe fixture files (public_test_vector.json,
 * artifact_manifest.json, synthetic_public_json_shape.json) are not flagged.
 * Does not read the filesystem.
 */
export function detectWithdrawZkRawArtifactPathWarnings(
  artifactPaths: string[],
  repoRoot: string,
  baseDir?: string
): string[] {
  if (!Array.isArray(artifactPaths)) {
    throw new Error(
      "detectWithdrawZkRawArtifactPathWarnings: artifactPaths must be an array"
    );
  }
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new Error(
      "detectWithdrawZkRawArtifactPathWarnings: repoRoot must be a non-empty string"
    );
  }
  if (
    baseDir !== undefined &&
    (typeof baseDir !== "string" || baseDir.length === 0)
  ) {
    throw new Error(
      "detectWithdrawZkRawArtifactPathWarnings: baseDir must be a non-empty string when provided"
    );
  }

  const normalizedRoot = path.resolve(repoRoot);
  const normalizedBase = path.resolve(baseDir ?? process.cwd());
  const warnings: string[] = [];

  for (const p of artifactPaths) {
    if (typeof p !== "string") {
      throw new Error(
        `detectWithdrawZkRawArtifactPathWarnings: artifactPaths entry must be a string, got ${JSON.stringify(
          p
        )}`
      );
    }
    const abs = path.isAbsolute(p)
      ? path.resolve(p)
      : path.resolve(normalizedBase, p);
    const base = path.basename(abs);
    if (isInsideRepo(abs, normalizedRoot) && isRawArtifact(base)) {
      warnings.push(
        `raw artifact path is inside the repository: ${p} -> ${abs} (${base})`
      );
    }
  }

  return warnings;
}
