// ZK artifact fixture schemas and loaders for WITHDRAW_SOL_V1.
//
// This module defines TypeScript interfaces for committed fixture files and
// provides loaders that validate required fields on read. It does not generate
// proofs, import snarkjs, or communicate with any external service.
//
// See tests/fixtures/zk/withdraw_sol_v1/ for the committed fixture files.
// See docs/PHASE4_STATUS_AND_GROTH16_CHECKLIST.md §5 for the integration roadmap.

import * as fs from "fs";

// ── Constants ─────────────────────────────────────────────────────────────────

export const WITHDRAW_SOL_V1 = "WITHDRAW_SOL_V1" as const;

export const PUBLIC_INPUTS_ORDER = [
  "root",
  "nullifier_hash",
  "tx_hash",
] as const;

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ZkFixtureParams {
  program_id: string;
  pool_pda: string;
  config_pda: string;
  recipient: string;
  relayer: string;
  denomination: string;
  fee: string;
  chain_id: string;
  expiry_slot: string;
  circuit_version: string;
}

export interface ZkPublicInputsFixture {
  schema_version: string;
  circuit: typeof WITHDRAW_SOL_V1;
  description: string;
  params: ZkFixtureParams;
  public_inputs_order: ["root", "nullifier_hash", "tx_hash"];
  root_be_hex: string;
  nullifier_hash_be_hex: string;
  tx_hash_be_hex: string;
}

export interface ZkArtifactManifest {
  schema_version: string;
  circuit: typeof WITHDRAW_SOL_V1;
  status: "placeholder" | "real";
  notes: string;
  circuit_hash_sha256: string | null;
  proving_key_hash_sha256: string | null;
  verification_key_hash_sha256: string | null;
  canonical_proof_fixture_hash_sha256: string | null;
  generated_at: string | null;
  generator_tool: string | null;
}

// ZkProofJson documents the snarkjs groth16 proof format.
// No proof file is committed in this PR; this interface documents the expected
// shape for the future real-proof integration step.
export interface ZkProofJson {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: "groth16";
  curve: "bn128";
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function readJsonFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`loadFixture: cannot read file ${filePath}: ${msg}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`loadFixture: invalid JSON in ${filePath}: ${msg}`);
  }
}

function assertStringField(
  obj: Record<string, unknown>,
  field: string,
  context: string
): string {
  const v = obj[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `${context}: field "${field}" must be a non-empty string, got ${JSON.stringify(
        v
      )}`
    );
  }
  return v;
}

function assertNullableStringField(
  obj: Record<string, unknown>,
  field: string,
  context: string
): string | null {
  if (!(field in obj)) {
    throw new Error(`${context}: field "${field}" is absent`);
  }
  const v = obj[field];
  if (v === null) return null;
  if (typeof v !== "string") {
    throw new Error(
      `${context}: field "${field}" must be a string or null, got ${JSON.stringify(
        v
      )}`
    );
  }
  return v;
}

function assertPublicInputOrder(
  order: unknown,
  context: string
): ["root", "nullifier_hash", "tx_hash"] {
  const expected = ["root", "nullifier_hash", "tx_hash"];
  if (
    !Array.isArray(order) ||
    order.length !== 3 ||
    order[0] !== expected[0] ||
    order[1] !== expected[1] ||
    order[2] !== expected[2]
  ) {
    throw new Error(
      `${context}: public_inputs_order must be exactly ["root", "nullifier_hash", "tx_hash"], got ${JSON.stringify(
        order
      )}`
    );
  }
  return order as ["root", "nullifier_hash", "tx_hash"];
}

function assertParamsObject(
  obj: Record<string, unknown>,
  context: string
): ZkFixtureParams {
  const params = obj["params"];
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error(`${context}: "params" must be an object`);
  }
  const p = params as Record<string, unknown>;
  const fields: (keyof ZkFixtureParams)[] = [
    "program_id",
    "pool_pda",
    "config_pda",
    "recipient",
    "relayer",
    "denomination",
    "fee",
    "chain_id",
    "expiry_slot",
    "circuit_version",
  ];
  const result: Partial<ZkFixtureParams> = {};
  for (const field of fields) {
    result[field] = assertStringField(p, field, `${context}.params`);
  }
  return result as ZkFixtureParams;
}

// ── Loaders ───────────────────────────────────────────────────────────────────

/**
 * Load and validate a ZkPublicInputsFixture from a JSON file.
 *
 * Throws if:
 * - the file cannot be read or is not valid JSON
 * - any required top-level field is absent or the wrong type
 * - params is absent or any params field is absent or non-string
 * - public_inputs_order is not exactly ["root", "nullifier_hash", "tx_hash"]
 * - circuit is not WITHDRAW_SOL_V1
 */
export function loadPublicInputsFixture(
  filePath: string
): ZkPublicInputsFixture {
  const ctx = `loadPublicInputsFixture(${filePath})`;
  const raw = readJsonFile(filePath) as Record<string, unknown>;

  const schema_version = assertStringField(raw, "schema_version", ctx);
  const circuit = assertStringField(raw, "circuit", ctx);
  if (circuit !== WITHDRAW_SOL_V1) {
    throw new Error(
      `${ctx}: circuit must be "${WITHDRAW_SOL_V1}", got "${circuit}"`
    );
  }
  const description = assertStringField(raw, "description", ctx);
  const params = assertParamsObject(raw, ctx);
  const public_inputs_order = assertPublicInputOrder(
    raw["public_inputs_order"],
    ctx
  );
  const root_be_hex = assertStringField(raw, "root_be_hex", ctx);
  const nullifier_hash_be_hex = assertStringField(
    raw,
    "nullifier_hash_be_hex",
    ctx
  );
  const tx_hash_be_hex = assertStringField(raw, "tx_hash_be_hex", ctx);

  return {
    schema_version,
    circuit,
    description,
    params,
    public_inputs_order,
    root_be_hex,
    nullifier_hash_be_hex,
    tx_hash_be_hex,
  };
}

/**
 * Load and validate a ZkArtifactManifest from a JSON file.
 *
 * Throws if:
 * - the file cannot be read or is not valid JSON
 * - any required field is absent or the wrong type
 * - status is not "placeholder" or "real"
 * - circuit is not WITHDRAW_SOL_V1
 */
export function loadArtifactManifest(filePath: string): ZkArtifactManifest {
  const ctx = `loadArtifactManifest(${filePath})`;
  const raw = readJsonFile(filePath) as Record<string, unknown>;

  const schema_version = assertStringField(raw, "schema_version", ctx);
  const circuit = assertStringField(raw, "circuit", ctx);
  if (circuit !== WITHDRAW_SOL_V1) {
    throw new Error(
      `${ctx}: circuit must be "${WITHDRAW_SOL_V1}", got "${circuit}"`
    );
  }
  const status = assertStringField(raw, "status", ctx);
  if (status !== "placeholder" && status !== "real") {
    throw new Error(
      `${ctx}: status must be "placeholder" or "real", got "${status}"`
    );
  }
  const notes = assertStringField(raw, "notes", ctx);

  const circuit_hash_sha256 = assertNullableStringField(
    raw,
    "circuit_hash_sha256",
    ctx
  );
  const proving_key_hash_sha256 = assertNullableStringField(
    raw,
    "proving_key_hash_sha256",
    ctx
  );
  const verification_key_hash_sha256 = assertNullableStringField(
    raw,
    "verification_key_hash_sha256",
    ctx
  );
  const canonical_proof_fixture_hash_sha256 = assertNullableStringField(
    raw,
    "canonical_proof_fixture_hash_sha256",
    ctx
  );
  const generated_at = assertNullableStringField(raw, "generated_at", ctx);
  const generator_tool = assertNullableStringField(raw, "generator_tool", ctx);

  return {
    schema_version,
    circuit,
    status: status as "placeholder" | "real",
    notes,
    circuit_hash_sha256,
    proving_key_hash_sha256,
    verification_key_hash_sha256,
    canonical_proof_fixture_hash_sha256,
    generated_at,
    generator_tool,
  };
}
