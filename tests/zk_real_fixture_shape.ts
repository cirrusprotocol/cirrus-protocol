import { expect } from "chai";
import { execSync } from "child_process";
import * as fs from "fs";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import { computePubkeysHash, computeTxHash } from "../lib/zk_prover/witness";
import {
  loadArtifactManifest,
  loadPublicInputsFixture,
  PUBLIC_INPUTS_ORDER,
  WITHDRAW_SOL_V1,
} from "../lib/zk_prover/fixture";

const FIXTURE_PATH =
  "tests/fixtures/zk/withdraw_sol_v1/public_test_vector.json";
const MANIFEST_PATH =
  "tests/fixtures/zk/withdraw_sol_v1/artifact_manifest.json";
const IGNORED_PROOF_PATH = "tests/fixtures/zk/withdraw_sol_v1/proof.json";
const IGNORED_VK_PATH =
  "tests/fixtures/zk/withdraw_sol_v1/verification_key.json";

const HEX32_RE = /^[0-9a-f]{64}$/;

function gitTracked(path: string): string {
  return execSync(`git ls-files ${path}`, { encoding: "utf8" }).trim();
}

describe("zk_real_fixture_shape: WITHDRAW_SOL_V1 fixture plumbing", function () {
  this.timeout(60_000);

  before(async () => {
    await initPoseidon();
  });

  // 1. Fixture file loads without error
  it("fixture file loads without error", () => {
    const fixture = loadPublicInputsFixture(FIXTURE_PATH);
    expect(fixture).to.be.an("object");
  });

  // 2. Public input order is locked: ["root", "nullifier_hash", "tx_hash"]
  it("public input order is locked: ['root', 'nullifier_hash', 'tx_hash']", () => {
    const fixture = loadPublicInputsFixture(FIXTURE_PATH);
    expect(fixture.public_inputs_order).to.deep.equal(PUBLIC_INPUTS_ORDER);
  });

  // 3. tx_hash_be_hex matches computeTxHash(...) for fixture params
  it("tx_hash_be_hex matches computeTxHash(...) for fixture params", () => {
    const fixture = loadPublicInputsFixture(FIXTURE_PATH);
    const p = fixture.params;
    const pubkeysHash = computePubkeysHash(
      p.program_id,
      p.pool_pda,
      p.config_pda,
      p.recipient,
      p.relayer
    );
    const txHash = computeTxHash(
      pubkeysHash,
      BigInt(p.denomination),
      BigInt(p.fee),
      BigInt(p.chain_id),
      BigInt(p.expiry_slot),
      BigInt(p.circuit_version)
    );
    expect(txHash).to.equal(fixture.tx_hash_be_hex);
  });

  // 4. root_be_hex is valid 64-char lowercase hex
  it("root_be_hex is valid 64-char lowercase hex", () => {
    const fixture = loadPublicInputsFixture(FIXTURE_PATH);
    expect(HEX32_RE.test(fixture.root_be_hex)).to.be.true;
  });

  // 5. nullifier_hash_be_hex is valid 64-char lowercase hex
  it("nullifier_hash_be_hex is valid 64-char lowercase hex", () => {
    const fixture = loadPublicInputsFixture(FIXTURE_PATH);
    expect(HEX32_RE.test(fixture.nullifier_hash_be_hex)).to.be.true;
  });

  // 6. tx_hash_be_hex is valid 64-char lowercase hex
  it("tx_hash_be_hex is valid 64-char lowercase hex", () => {
    const fixture = loadPublicInputsFixture(FIXTURE_PATH);
    expect(HEX32_RE.test(fixture.tx_hash_be_hex)).to.be.true;
  });

  // 7. circuit field is WITHDRAW_SOL_V1
  it("circuit field is WITHDRAW_SOL_V1", () => {
    const fixture = loadPublicInputsFixture(FIXTURE_PATH);
    expect(fixture.circuit).to.equal(WITHDRAW_SOL_V1);
  });

  // 8. Artifact manifest loads without error
  it("artifact manifest loads without error", () => {
    const manifest = loadArtifactManifest(MANIFEST_PATH);
    expect(manifest).to.be.an("object");
  });

  // 9. Artifact manifest status is "real"
  it("artifact manifest status is 'real'", () => {
    const manifest = loadArtifactManifest(MANIFEST_PATH);
    expect(manifest.status).to.equal("real");
  });

  // 10. When status is "real", all artifact hash fields are populated 64-char lowercase hex.
  it("when status is 'real', all artifact hash fields are 64-char lowercase hex", () => {
    const manifest = loadArtifactManifest(MANIFEST_PATH);
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    if (manifest.status === "real") {
      expect(HEX32_RE.test(manifest.circuit_hash_sha256 as string)).to.be.true;
      expect(HEX32_RE.test(manifest.proving_key_hash_sha256 as string)).to.be
        .true;
      expect(HEX32_RE.test(manifest.verification_key_hash_sha256 as string)).to
        .be.true;
      expect(
        HEX32_RE.test(manifest.canonical_proof_fixture_hash_sha256 as string)
      ).to.be.true;
      expect(HEX32_RE.test(raw.ptau_hash_sha256 as string)).to.be.true;
      expect(HEX32_RE.test(raw.circuit_source_hash_sha256 as string)).to.be
        .true;
      // phase2_contribution_hash is Blake2b-512: 128 hex chars
      const HEX64_RE = /^[0-9a-f]{128}$/;
      expect(HEX64_RE.test(raw.phase2_contribution_hash as string)).to.be.true;
      // ptau_source_url is the official iden3/snarkjs GCS URL
      expect(raw.ptau_source_url).to.equal(
        "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_13.ptau"
      );
    }
  });

  // 11. When status is "real", generated_at and generator_tool are non-empty strings.
  it("when status is 'real', generated_at and generator_tool are non-empty strings", () => {
    const manifest = loadArtifactManifest(MANIFEST_PATH);
    if (manifest.status === "real") {
      expect(manifest.generated_at).to.be.a("string").and.not.equal("");
      expect(manifest.generator_tool).to.be.a("string").and.not.equal("");
    }
  });

  // 12. proof.json is not git-tracked
  it("proof.json is not git-tracked", () => {
    expect(gitTracked(IGNORED_PROOF_PATH)).to.equal("");
  });

  // 13. verification_key.json is not git-tracked
  it("verification_key.json is not git-tracked", () => {
    expect(gitTracked(IGNORED_VK_PATH)).to.equal("");
  });

  // 14. Artifact manifest schema_version is "2"
  it("artifact manifest schema_version is '2'", () => {
    const manifest = loadArtifactManifest(MANIFEST_PATH);
    expect(manifest.schema_version).to.equal("2");
  });

  // 15. Artifact manifest audit_status is "not-audited"
  it("artifact manifest audit_status is 'not-audited'", () => {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw.audit_status).to.equal("not-audited");
  });

  // 16. Artifact manifest deployment_scope is "devnet-only"
  it("artifact manifest deployment_scope is 'devnet-only'", () => {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw.deployment_scope).to.equal("devnet-only");
  });
});
