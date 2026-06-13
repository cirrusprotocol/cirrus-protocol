import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  normalizeHexOrDecimalToHex32,
  parseWithdrawZkPublicInputs,
  parseWithdrawZkInputScalars,
  validateWithdrawZkScalarsAgainstPublicInputs,
  deriveWithdrawZkPoolStatePda,
  deriveWithdrawZkVerifierConfigPda,
  deriveWithdrawZkNullifierMarkerPda,
  detectWithdrawZkRawArtifactPathWarnings,
  WithdrawZkPublicInputs,
} from "../lib/zk_prover/withdraw_zk_artifacts";

const ZERO_HEX = "0".repeat(64);
const ONE_HEX = "0".repeat(63) + "1";
const LOCKED_TX_HASH =
  "17115e272898a4cca8177791e2e99f51b2e01e7bc2d1381164217f6ef931bcac";
const LOCKED_TX_HASH_DEC =
  "10433881737386163460470444104344813805287698727706633656158202324469777808556";
const MAX_HEX = "f".repeat(64);
const TWO_256_DEC = (2n ** 256n).toString(10);

describe("zk_withdraw_artifacts: helper module", function () {
  // ── normalizeHexOrDecimalToHex32 ──────────────────────────────────────────────

  describe("normalizeHexOrDecimalToHex32", function () {
    it("accepts 64-char lowercase hex unchanged", () => {
      expect(normalizeHexOrDecimalToHex32(LOCKED_TX_HASH, "root")).to.equal(
        LOCKED_TX_HASH
      );
    });

    it("accepts 64-char uppercase hex and returns lowercase", () => {
      expect(
        normalizeHexOrDecimalToHex32(LOCKED_TX_HASH.toUpperCase(), "root")
      ).to.equal(LOCKED_TX_HASH);
    });

    it("accepts 0x-prefixed hex", () => {
      expect(
        normalizeHexOrDecimalToHex32("0x" + LOCKED_TX_HASH, "root")
      ).to.equal(LOCKED_TX_HASH);
    });

    it("accepts 0X-prefixed hex", () => {
      expect(
        normalizeHexOrDecimalToHex32("0X" + LOCKED_TX_HASH, "root")
      ).to.equal(LOCKED_TX_HASH);
    });

    it('accepts decimal "0" and returns 64 zeroes', () => {
      expect(normalizeHexOrDecimalToHex32("0", "root")).to.equal(ZERO_HEX);
    });

    it('accepts decimal "1" and returns 63 zeroes + 1', () => {
      expect(normalizeHexOrDecimalToHex32("1", "root")).to.equal(ONE_HEX);
    });

    it("accepts decimal form of locked tx_hash and returns its hex", () => {
      expect(
        normalizeHexOrDecimalToHex32(LOCKED_TX_HASH_DEC, "tx_hash")
      ).to.equal(LOCKED_TX_HASH);
    });

    it("accepts max 64-char hex (2^256 - 1)", () => {
      expect(normalizeHexOrDecimalToHex32(MAX_HEX, "root")).to.equal(MAX_HEX);
    });

    it("treats a bare 64-digit decimal string as decimal, not hex", () => {
      const SIXTY_FOUR_DIGIT_DEC = "1" + "0".repeat(63);
      expect(
        normalizeHexOrDecimalToHex32(SIXTY_FOUR_DIGIT_DEC, "root")
      ).to.equal(BigInt(SIXTY_FOUR_DIGIT_DEC).toString(16).padStart(64, "0"));
    });

    it("treats a 0x-prefixed numeric-looking 64-char value as hex", () => {
      expect(
        normalizeHexOrDecimalToHex32("0x" + "1".repeat(64), "root")
      ).to.equal("1".repeat(64));
    });

    it("accepts a bare 64-char hex containing letters", () => {
      const withLetters = "a".repeat(63) + "b";
      expect(normalizeHexOrDecimalToHex32(withLetters, "root")).to.equal(
        withLetters
      );
    });

    it("rejects non-string input", () => {
      expect(() =>
        normalizeHexOrDecimalToHex32(123 as unknown as string, "root")
      ).to.throw();
    });

    it("rejects empty string", () => {
      expect(() => normalizeHexOrDecimalToHex32("", "root")).to.throw();
    });

    it("rejects short hex (63 chars)", () => {
      expect(() =>
        normalizeHexOrDecimalToHex32("a".repeat(63), "root")
      ).to.throw();
    });

    it("rejects long hex (65 chars)", () => {
      expect(() =>
        normalizeHexOrDecimalToHex32("a".repeat(65), "root")
      ).to.throw();
    });

    it("rejects non-hex / non-decimal junk", () => {
      expect(() =>
        normalizeHexOrDecimalToHex32("not-a-number", "root")
      ).to.throw();
    });

    it('rejects negative decimal "-1"', () => {
      expect(() => normalizeHexOrDecimalToHex32("-1", "root")).to.throw();
    });

    it("rejects decimal value >= 2^256", () => {
      expect(() => normalizeHexOrDecimalToHex32(TWO_256_DEC, "root")).to.throw(
        /exceeds/
      );
    });
  });

  // ── parseWithdrawZkPublicInputs ───────────────────────────────────────────────

  describe("parseWithdrawZkPublicInputs", function () {
    const validRaw = ["0", "1", LOCKED_TX_HASH_DEC];

    it("accepts a valid snarkjs public.json array of 3 decimal strings", () => {
      expect(() => parseWithdrawZkPublicInputs(validRaw)).to.not.throw();
    });

    it("returns keys rootBeHex, nullifierHashBeHex, txHashBeHex", () => {
      const result = parseWithdrawZkPublicInputs(validRaw);
      expect(result).to.have.keys([
        "rootBeHex",
        "nullifierHashBeHex",
        "txHashBeHex",
      ]);
    });

    it("maps element [0] to rootBeHex", () => {
      const result = parseWithdrawZkPublicInputs(validRaw);
      expect(result.rootBeHex).to.equal(ZERO_HEX);
    });

    it("maps element [1] to nullifierHashBeHex", () => {
      const result = parseWithdrawZkPublicInputs(validRaw);
      expect(result.nullifierHashBeHex).to.equal(ONE_HEX);
    });

    it("maps element [2] to txHashBeHex", () => {
      const result = parseWithdrawZkPublicInputs(validRaw);
      expect(result.txHashBeHex).to.equal(LOCKED_TX_HASH);
    });

    it("rejects malformed input (not an array)", () => {
      expect(() => parseWithdrawZkPublicInputs({ a: "0" })).to.throw();
    });
  });

  // ── parseWithdrawZkInputScalars ───────────────────────────────────────────────

  describe("parseWithdrawZkInputScalars", function () {
    it("maps snake_case fields to camelCase props", () => {
      const result = parseWithdrawZkInputScalars({
        denomination: "1000000000",
        fee: "5000",
        expiry_slot: "12345",
        circuit_version: "1",
        tx_hash: LOCKED_TX_HASH,
      });
      expect(result).to.deep.equal({
        denomination: "1000000000",
        fee: "5000",
        expirySlot: "12345",
        circuitVersion: "1",
        txHash: LOCKED_TX_HASH,
      });
    });

    it("returns empty object for an empty object", () => {
      expect(parseWithdrawZkInputScalars({})).to.deep.equal({});
    });

    it("ignores unknown fields", () => {
      const result = parseWithdrawZkInputScalars({
        denomination: "1",
        unknown_field: "ignored",
      });
      expect(result).to.deep.equal({ denomination: "1" });
    });

    it("rejects non-object input (null)", () => {
      expect(() => parseWithdrawZkInputScalars(null)).to.throw();
    });

    it("rejects non-object input (array)", () => {
      expect(() => parseWithdrawZkInputScalars(["x"])).to.throw();
    });

    it("rejects non-object input (string)", () => {
      expect(() => parseWithdrawZkInputScalars("denomination")).to.throw();
    });

    it("rejects recognized field that is not a string (number)", () => {
      expect(() =>
        parseWithdrawZkInputScalars({ denomination: 1000 })
      ).to.throw(/denomination/);
    });

    it("rejects recognized field that is not a string (expiry_slot number)", () => {
      expect(() =>
        parseWithdrawZkInputScalars({ expiry_slot: 12345 })
      ).to.throw(/expiry_slot/);
    });
  });

  // ── validateWithdrawZkScalarsAgainstPublicInputs ──────────────────────────────

  describe("validateWithdrawZkScalarsAgainstPublicInputs", function () {
    const publicInputs: WithdrawZkPublicInputs = {
      rootBeHex: ZERO_HEX,
      nullifierHashBeHex: ONE_HEX,
      txHashBeHex: LOCKED_TX_HASH,
    };

    it("ok: true when scalars.txHash (hex) matches public tx_hash", () => {
      const result = validateWithdrawZkScalarsAgainstPublicInputs(
        { txHash: LOCKED_TX_HASH },
        publicInputs
      );
      expect(result.ok).to.be.true;
      expect(result.mismatches).to.have.length(0);
    });

    it("ok: true when scalars.txHash (0x-prefixed) matches public tx_hash", () => {
      const result = validateWithdrawZkScalarsAgainstPublicInputs(
        { txHash: "0x" + LOCKED_TX_HASH },
        publicInputs
      );
      expect(result.ok).to.be.true;
    });

    it("ok: true when scalars.txHash (decimal) matches public tx_hash", () => {
      const result = validateWithdrawZkScalarsAgainstPublicInputs(
        { txHash: LOCKED_TX_HASH_DEC },
        publicInputs
      );
      expect(result.ok).to.be.true;
    });

    it("ok: true when scalars.txHash is absent (nothing to cross-check)", () => {
      const result = validateWithdrawZkScalarsAgainstPublicInputs(
        { denomination: "1000000000" },
        publicInputs
      );
      expect(result.ok).to.be.true;
      expect(result.mismatches).to.have.length(0);
    });

    it("ok: false with 'tx_hash' mismatch when scalars.txHash differs", () => {
      const result = validateWithdrawZkScalarsAgainstPublicInputs(
        { txHash: ONE_HEX },
        publicInputs
      );
      expect(result.ok).to.be.false;
      expect(result.mismatches).to.include("tx_hash");
    });

    it("throws when scalars.txHash is not a valid hex/decimal scalar", () => {
      expect(() =>
        validateWithdrawZkScalarsAgainstPublicInputs(
          { txHash: "not-a-number" },
          publicInputs
        )
      ).to.throw();
    });
  });

  // ── PDA derivation ────────────────────────────────────────────────────────────

  const TEST_PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
  const EXPECTED_POOL_STATE_PDA =
    "HcAkT4obzEEaHyevyVvmU7drEtSUg1m4XxF1VTWGoCdm";
  const EXPECTED_VERIFIER_CONFIG_PDA =
    "6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu";
  const NULLIFIER_HASH =
    "27cb78d0541f3912c8645bd60acbe7a7205225e0e6f55a17f4843ac719e3eafe";

  describe("deriveWithdrawZkPoolStatePda", function () {
    it("derives expected pool_state PDA for known program id", () => {
      const programId = new PublicKey(TEST_PROGRAM_ID);
      const [pda] = deriveWithdrawZkPoolStatePda(programId);
      expect(pda.toBase58()).to.equal(EXPECTED_POOL_STATE_PDA);
    });
  });

  describe("deriveWithdrawZkVerifierConfigPda", function () {
    it("derives expected verifier_config PDA for known program id", () => {
      const programId = new PublicKey(TEST_PROGRAM_ID);
      const [pda] = deriveWithdrawZkVerifierConfigPda(programId);
      expect(pda.toBase58()).to.equal(EXPECTED_VERIFIER_CONFIG_PDA);
    });
  });

  describe("deriveWithdrawZkNullifierMarkerPda", function () {
    it("is deterministic: same inputs return same PDA and bump", () => {
      const programId = new PublicKey(TEST_PROGRAM_ID);
      const [pda1, bump1] = deriveWithdrawZkNullifierMarkerPda(
        programId,
        NULLIFIER_HASH
      );
      const [pda2, bump2] = deriveWithdrawZkNullifierMarkerPda(
        programId,
        NULLIFIER_HASH
      );
      expect(pda1.toBase58()).to.equal(pda2.toBase58());
      expect(bump1).to.equal(bump2);
    });

    it("returned PDA is a valid PublicKey", () => {
      const programId = new PublicKey(TEST_PROGRAM_ID);
      const [pda] = deriveWithdrawZkNullifierMarkerPda(
        programId,
        NULLIFIER_HASH
      );
      expect(pda).to.be.instanceOf(PublicKey);
    });

    it("bump is a number between 0 and 255", () => {
      const programId = new PublicKey(TEST_PROGRAM_ID);
      const [, bump] = deriveWithdrawZkNullifierMarkerPda(
        programId,
        NULLIFIER_HASH
      );
      expect(bump).to.be.a("number").and.to.be.at.least(0).and.at.most(255);
    });

    it("uppercase nullifier hash returns the same PDA as lowercase", () => {
      const programId = new PublicKey(TEST_PROGRAM_ID);
      const [pdaLower] = deriveWithdrawZkNullifierMarkerPda(
        programId,
        NULLIFIER_HASH
      );
      const [pdaUpper] = deriveWithdrawZkNullifierMarkerPda(
        programId,
        NULLIFIER_HASH.toUpperCase()
      );
      expect(pdaLower.toBase58()).to.equal(pdaUpper.toBase58());
    });

    it("rejects a short nullifier hash", () => {
      const programId = new PublicKey(TEST_PROGRAM_ID);
      expect(() =>
        deriveWithdrawZkNullifierMarkerPda(
          programId,
          NULLIFIER_HASH.slice(0, 63)
        )
      ).to.throw(/nullifierHashBeHex/);
    });

    it("rejects a long nullifier hash", () => {
      const programId = new PublicKey(TEST_PROGRAM_ID);
      expect(() =>
        deriveWithdrawZkNullifierMarkerPda(programId, NULLIFIER_HASH + "0")
      ).to.throw(/nullifierHashBeHex/);
    });

    it("rejects a non-hex nullifier hash", () => {
      const programId = new PublicKey(TEST_PROGRAM_ID);
      expect(() =>
        deriveWithdrawZkNullifierMarkerPda(programId, "z".repeat(64))
      ).to.throw(/nullifierHashBeHex/);
    });
  });

  // ── detectWithdrawZkRawArtifactPathWarnings ───────────────────────────────────

  describe("detectWithdrawZkRawArtifactPathWarnings", function () {
    const FAKE_REPO_ROOT = "/tmp/cirrus-anchor";
    const FAKE_BASE_DIR = "/tmp/cirrus-anchor";
    const OUTSIDE_DIR = "/tmp/zk-artifacts/withdraw_sol_v1";

    it("warns for raw artifact basenames inside repo: proof.json", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/proof.json"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include(
        "raw artifact path is inside the repository"
      );
      expect(warnings[0]).to.include("proof.json");
    });

    it("warns for raw artifact basenames inside repo: public.json", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/public.json"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("public.json");
    });

    it("warns for raw artifact basenames inside repo: input.json", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/input.json"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("input.json");
    });

    it("warns for raw artifact basenames inside repo: verification_key.json", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/verification_key.json"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("verification_key.json");
    });

    it("warns for raw artifact basenames inside repo: metadata.json", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/metadata.json"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("metadata.json");
    });

    it("warns for raw artifact extension .ptau inside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/artifact.ptau"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include(".ptau");
    });

    it("warns for raw artifact extension .r1cs inside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/artifact.r1cs"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
    });

    it("warns for raw artifact extension .wasm inside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/artifact.wasm"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
    });

    it("warns for raw artifact extension .sym inside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/artifact.sym"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
    });

    it("warns for raw artifact extension .wtns inside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/artifact.wtns"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
    });

    it("warns for raw artifact extension .zkey inside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [FAKE_REPO_ROOT + "/artifact.zkey"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(1);
    });

    it("does not warn for proof.json outside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [OUTSIDE_DIR + "/proof.json"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(0);
    });

    it("does not warn for public.json outside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [OUTSIDE_DIR + "/public.json"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(0);
    });

    it("does not warn for input.json outside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [OUTSIDE_DIR + "/input.json"],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(0);
    });

    it("does not warn for safe fixture: public_test_vector.json", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [
          FAKE_REPO_ROOT +
            "/tests/fixtures/zk/withdraw_sol_v1/public_test_vector.json",
        ],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(0);
    });

    it("does not warn for safe fixture: artifact_manifest.json", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [
          FAKE_REPO_ROOT +
            "/tests/fixtures/zk/withdraw_sol_v1/artifact_manifest.json",
        ],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(0);
    });

    it("does not warn for safe fixture: synthetic_public_json_shape.json", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [
          FAKE_REPO_ROOT +
            "/tests/fixtures/zk/withdraw_sol_v1/synthetic_public_json_shape.json",
        ],
        FAKE_REPO_ROOT
      );
      expect(warnings).to.have.length(0);
    });

    it("resolves relative path using baseDir: warns when inside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        ["proof.json"],
        FAKE_REPO_ROOT,
        FAKE_BASE_DIR
      );
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include(
        "raw artifact path is inside the repository"
      );
    });

    it("resolves relative path using baseDir: no warn when outside repo", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        ["proof.json"],
        FAKE_REPO_ROOT,
        OUTSIDE_DIR
      );
      expect(warnings).to.have.length(0);
    });

    it("does not confuse a sibling directory with the repo root", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        ["/tmp/repo2/proof.json"],
        "/tmp/repo"
      );
      expect(warnings).to.have.length(0);
    });

    it("warning includes original path, resolved absolute path, and basename", () => {
      const inputPath = FAKE_REPO_ROOT + "/proof.json";
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        [inputPath],
        FAKE_REPO_ROOT
      );
      expect(warnings[0]).to.include(inputPath);
      expect(warnings[0]).to.include("proof.json");
      expect(warnings[0]).to.include(
        "raw artifact path is inside the repository"
      );
    });

    it("warning detail: relative path shows original, resolved absolute, and basename in parens", () => {
      const warnings = detectWithdrawZkRawArtifactPathWarnings(
        ["proof.json"],
        FAKE_REPO_ROOT,
        FAKE_BASE_DIR
      );
      expect(warnings[0]).to.include("proof.json");
      expect(warnings[0]).to.include(FAKE_REPO_ROOT + "/proof.json");
      expect(warnings[0]).to.include("(proof.json)");
      expect(warnings[0]).to.include(
        "raw artifact path is inside the repository"
      );
    });

    it("throws when artifactPaths is not an array", () => {
      expect(() =>
        detectWithdrawZkRawArtifactPathWarnings(
          "proof.json" as unknown as string[],
          FAKE_REPO_ROOT
        )
      ).to.throw(/artifactPaths/);
    });

    it("throws when an artifact path item is not a string", () => {
      expect(() =>
        detectWithdrawZkRawArtifactPathWarnings(
          [42 as unknown as string],
          FAKE_REPO_ROOT
        )
      ).to.throw(/artifactPaths/);
    });

    it("throws when repoRoot is empty", () => {
      expect(() => detectWithdrawZkRawArtifactPathWarnings([], "")).to.throw(
        /repoRoot/
      );
    });

    it("throws when baseDir is empty string", () => {
      expect(() =>
        detectWithdrawZkRawArtifactPathWarnings([], FAKE_REPO_ROOT, "")
      ).to.throw(/baseDir/);
    });
  });
});
