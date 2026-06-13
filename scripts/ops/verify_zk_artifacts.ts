#!/usr/bin/env ts-node
/**
 * Read-only verifier for local ZK artifact files against an artifact manifest.
 *
 * Computes the SHA-256 of operator/tester-provided local artifact files (.zkey,
 * .wasm, verification key) and compares them to the hashes recorded in an
 * existing artifact manifest (e.g.
 * tests/fixtures/zk/withdraw_sol_v1/artifact_manifest.json) BEFORE the files are
 * used for witness/proof generation.
 *
 * This is a hash/provenance consistency check only. It is NOT an audit, it does
 * not validate the circuit, and it does not make the trusted setup multi-party.
 * A match means "this file is byte-identical to the artifact whose hash the
 * manifest records" — nothing more.
 *
 * SECURITY / SCOPE:
 *   - Read-only: reads the manifest and the artifact files; writes nothing.
 *   - No network access. No RPC. No transactions.
 *   - No keypairs are read or required.
 *   - Artifact file CONTENTS are never printed — only their SHA-256 and path.
 *
 * The manifest is adapted to its real shape: each artifact type maps to a set of
 * candidate hash field names, and the first field that exists is used. The tool
 * does NOT guess an unrelated field. The current schema (v2) records proving_key
 * and verification_key hashes but no wasm hash; circuit_hash_sha256 is the
 * compiled circuit, not the wasm, so it is deliberately not used for the wasm.
 *
 * Safe by default: if the manifest records no hash for a provided artifact, that
 * artifact is treated as a FAILURE (it cannot be verified). For example, with the
 * current manifest the .wasm cannot be verified until a wasm hash is recorded.
 * Pass --allow-unverified to proceed anyway; such artifacts are then reported,
 * loudly, as UNVERIFIED rather than verified.
 *
 * Usage:
 *   npx ts-node scripts/ops/verify_zk_artifacts.ts \
 *     --manifest tests/fixtures/zk/withdraw_sol_v1/artifact_manifest.json \
 *     --zkey <path-to.zkey> [--wasm <path-to.wasm>] [--vk <path-to-vk.json>] \
 *     [--json] [--allow-unverified]
 *
 * Flags:
 *   --manifest <path>    Required. Artifact manifest JSON.
 *   --zkey <path>        Proving key file to verify (vs proving_key_hash_sha256).
 *   --wasm <path>        Witness calculator wasm to verify (vs a wasm hash field).
 *   --vk <path>          Verification key JSON to verify (vs verification_key_hash_sha256).
 *   --json               Emit machine-readable JSON instead of human text.
 *   --allow-unverified   Do not fail when the manifest records no hash for a
 *                        provided artifact; report it as UNVERIFIED instead.
 *
 * At least one of --zkey / --wasm / --vk is required.
 *
 * Exit codes:
 *   0  every provided artifact was verified against a manifest hash and matched
 *      (or, with --allow-unverified, the only issues were missing manifest hashes)
 *   1  missing/malformed/unsupported manifest, missing artifact file, hash
 *      mismatch, or a provided artifact with no manifest hash (unless
 *      --allow-unverified is given)
 */

import * as crypto from "crypto";
import * as fs from "fs";

// ── Artifact → manifest-field mapping ──────────────────────────────────────────
//
// Each artifact maps to an ordered list of candidate manifest field names. The
// first field present (a non-empty string) is used as the expected hash. This is
// intentionally tolerant of manifest evolution and does NOT assume a field that
// is not actually present. The current schema (v2) records proving_key and
// verification_key hashes but no wasm hash; circuit_hash_sha256 is the compiled
// circuit, not the wasm, so it is deliberately not used here.

export interface ArtifactSpec {
  key: string;
  label: string;
  fields: string[];
}

export const ARTIFACT_SPECS: Record<"zkey" | "wasm" | "vk", ArtifactSpec> = {
  zkey: {
    key: "zkey",
    label: "proving key (.zkey)",
    fields: ["proving_key_hash_sha256", "zkey_hash_sha256"],
  },
  wasm: {
    key: "wasm",
    label: "witness calculator (.wasm)",
    fields: [
      "wasm_hash_sha256",
      "witness_wasm_hash_sha256",
      "circuit_wasm_hash_sha256",
    ],
  },
  vk: {
    key: "vk",
    label: "verification key (json)",
    fields: ["verification_key_hash_sha256", "vk_hash_sha256"],
  },
};

// ── Hashing ────────────────────────────────────────────────────────────────────

/** Computes the lowercase hex SHA-256 of a file. Reads bytes; never logs them. */
export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ── Manifest loading ────────────────────────────────────────────────────────────

/**
 * Reads and parses the manifest. Throws on a missing file, invalid JSON, or a
 * shape that is not a plain JSON object (unsupported manifest shape).
 */
export function loadManifest(manifestPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (e) {
    throw new Error(
      `cannot read manifest "${manifestPath}": ${(e as Error).message}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `manifest is not valid JSON "${manifestPath}": ${(e as Error).message}`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `unsupported manifest shape: expected a JSON object, got ` +
        `${
          parsed === null
            ? "null"
            : Array.isArray(parsed)
            ? "array"
            : typeof parsed
        }`
    );
  }
  return parsed as Record<string, unknown>;
}

/** Resolves the expected hash for an artifact from the first present field. */
export function expectedHashFor(
  manifest: Record<string, unknown>,
  spec: ArtifactSpec
): { field: string | null; hash: string | null } {
  for (const f of spec.fields) {
    const v = manifest[f];
    if (typeof v === "string" && v.trim().length > 0) {
      return { field: f, hash: v.trim().toLowerCase() };
    }
  }
  return { field: null, hash: null };
}

// ── Per-artifact verification ───────────────────────────────────────────────────

export type ArtifactStatus =
  | "MATCH"
  | "MISMATCH"
  | "NO_EXPECTED_HASH"
  | "FILE_MISSING";

export interface ArtifactResult {
  key: string;
  label: string;
  filePath: string;
  field: string | null;
  expectedHash: string | null;
  actualHash: string | null;
  status: ArtifactStatus;
}

export function verifyArtifact(
  manifest: Record<string, unknown>,
  spec: ArtifactSpec,
  filePath: string
): ArtifactResult {
  const { field, hash: expectedHash } = expectedHashFor(manifest, spec);

  if (!fs.existsSync(filePath)) {
    return {
      key: spec.key,
      label: spec.label,
      filePath,
      field,
      expectedHash,
      actualHash: null,
      status: "FILE_MISSING",
    };
  }

  const actualHash = sha256File(filePath);
  let status: ArtifactStatus;
  if (expectedHash === null) {
    status = "NO_EXPECTED_HASH";
  } else {
    status = actualHash === expectedHash ? "MATCH" : "MISMATCH";
  }

  return {
    key: spec.key,
    label: spec.label,
    filePath,
    field,
    expectedHash,
    actualHash,
    status,
  };
}

/**
 * Aggregates per-artifact results into an overall pass/fail + reasons.
 *
 * Safe by default: NO_EXPECTED_HASH is a failure. It is downgraded to a
 * non-fatal "unverified" only when allowUnverified is true.
 */
export function evaluate(
  results: ArtifactResult[],
  allowUnverified: boolean
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const r of results) {
    if (r.status === "FILE_MISSING") {
      reasons.push(`${r.key}: artifact file missing (${r.filePath})`);
    } else if (r.status === "MISMATCH") {
      reasons.push(`${r.key}: hash mismatch`);
    } else if (r.status === "NO_EXPECTED_HASH" && !allowUnverified) {
      reasons.push(
        `${r.key}: no expected hash recorded in manifest — this artifact ` +
          `cannot be verified until the manifest records a hash for it ` +
          `(re-run with --allow-unverified to proceed without verifying it)`
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ── Argument parsing ────────────────────────────────────────────────────────────

export interface VerifyArgs {
  manifest: string;
  zkey?: string;
  wasm?: string;
  vk?: string;
  json: boolean;
  allowUnverified: boolean;
}

export function parseArgs(argv: string[]): VerifyArgs {
  let manifest: string | undefined;
  let zkey: string | undefined;
  let wasm: string | undefined;
  let vk: string | undefined;
  let json = false;
  let allowUnverified = false;

  const takeValue = (i: number, flag: string): string => {
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return val;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--manifest") {
      manifest = takeValue(i, flag);
      i++;
    } else if (flag === "--zkey") {
      zkey = takeValue(i, flag);
      i++;
    } else if (flag === "--wasm") {
      wasm = takeValue(i, flag);
      i++;
    } else if (flag === "--vk") {
      vk = takeValue(i, flag);
      i++;
    } else if (flag === "--json") {
      json = true;
    } else if (flag === "--allow-unverified") {
      allowUnverified = true;
    } else {
      throw new Error(`parseArgs: unknown flag: ${flag}`);
    }
  }

  if (manifest === undefined) {
    throw new Error("--manifest is required");
  }
  if (zkey === undefined && wasm === undefined && vk === undefined) {
    throw new Error("at least one of --zkey / --wasm / --vk is required");
  }

  return { manifest, zkey, wasm, vk, json, allowUnverified };
}

/** Builds the ordered list of (spec, path) pairs for the provided artifacts. */
export function selectedArtifacts(
  args: VerifyArgs
): Array<{ spec: ArtifactSpec; path: string }> {
  const out: Array<{ spec: ArtifactSpec; path: string }> = [];
  if (args.zkey !== undefined)
    out.push({ spec: ARTIFACT_SPECS.zkey, path: args.zkey });
  if (args.wasm !== undefined)
    out.push({ spec: ARTIFACT_SPECS.wasm, path: args.wasm });
  if (args.vk !== undefined)
    out.push({ spec: ARTIFACT_SPECS.vk, path: args.vk });
  return out;
}

// ── Rendering ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<ArtifactStatus, string> = {
  MATCH: "MATCH",
  MISMATCH: "MISMATCH",
  NO_EXPECTED_HASH: "UNVERIFIED (no hash in manifest)",
  FILE_MISSING: "FILE MISSING",
};

export function renderHuman(
  manifestPath: string,
  results: ArtifactResult[],
  evalResult: { ok: boolean; reasons: string[] },
  allowUnverified: boolean
): string {
  const lines: string[] = [];
  lines.push(`ZK artifact verification (read-only)`);
  lines.push(`Manifest: ${manifestPath}`);
  lines.push(
    `Mode:     ${allowUnverified ? "allow-unverified" : "strict (default)"}`
  );
  lines.push(``);
  for (const r of results) {
    lines.push(`${r.label}`);
    lines.push(`  file:     ${r.filePath}`);
    lines.push(`  field:    ${r.field ?? "(none in manifest)"}`);
    lines.push(`  expected: ${r.expectedHash ?? "(none in manifest)"}`);
    lines.push(`  actual:   ${r.actualHash ?? "(not computed)"}`);
    lines.push(`  status:   ${STATUS_LABEL[r.status]}`);
    if (r.status === "NO_EXPECTED_HASH") {
      lines.push(
        `            (this artifact cannot be verified until the manifest ` +
          `records a hash for it)`
      );
    }
    lines.push(``);
  }
  if (evalResult.ok) {
    const unverified = results.filter((r) => r.status === "NO_EXPECTED_HASH");
    if (unverified.length > 0) {
      lines.push(
        `RESULT: PASS — all manifest-recorded artifacts matched. ` +
          `${unverified.length} artifact(s) had NO manifest hash and were NOT ` +
          `verified (allowed via --allow-unverified): ` +
          `${unverified.map((r) => r.key).join(", ")}.`
      );
    } else {
      lines.push(`RESULT: PASS — all provided artifacts match the manifest.`);
    }
  } else {
    lines.push(`RESULT: FAIL`);
    for (const reason of evalResult.reasons) {
      lines.push(`  - ${reason}`);
    }
  }
  lines.push(``);
  lines.push(
    `Note: this verifies hash/provenance consistency only. It is not an audit ` +
      `and does not make the trusted setup multi-party.`
  );
  return lines.join("\n");
}

export function renderJson(
  manifestPath: string,
  results: ArtifactResult[],
  evalResult: { ok: boolean; reasons: string[] },
  allowUnverified: boolean
): string {
  return JSON.stringify(
    {
      manifest: manifestPath,
      allow_unverified: allowUnverified,
      ok: evalResult.ok,
      reasons: evalResult.reasons,
      artifacts: results.map((r) => ({
        artifact: r.key,
        label: r.label,
        file: r.filePath,
        manifest_field: r.field,
        expected_sha256: r.expectedHash,
        actual_sha256: r.actualHash,
        status: r.status,
      })),
      disclaimer:
        "hash/provenance consistency check only; not an audit; trusted setup " +
        "remains single-party",
    },
    null,
    2
  );
}

// ── CLI entry point ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);

  const args = (() => {
    try {
      return parseArgs(argv);
    } catch (err) {
      console.error((err as Error).message);
      return process.exit(1);
    }
  })();

  const manifest = (() => {
    try {
      return loadManifest(args.manifest);
    } catch (err) {
      console.error((err as Error).message);
      return process.exit(1);
    }
  })();

  const results = selectedArtifacts(args).map(({ spec, path }) =>
    verifyArtifact(manifest, spec, path)
  );
  const evalResult = evaluate(results, args.allowUnverified);

  console.log(
    args.json
      ? renderJson(args.manifest, results, evalResult, args.allowUnverified)
      : renderHuman(args.manifest, results, evalResult, args.allowUnverified)
  );

  process.exit(evalResult.ok ? 0 : 1);
}
