import { expect } from "chai";
import {
  WITHDRAW_SOL_V1_PUBLIC_INPUTS_ORDER,
  bigintToHex32BE,
  decimalStringToHex32BE,
  normalizeSnarkjsPublicJson,
  loadSnarkjsPublicJson,
  loadAndNormalizeSnarkjsPublicJson,
  comparePublicInputsToVector,
  loadAndComparePublicInputs,
  formatPublicInputComparison,
  NormalizedPublicInputs,
} from "../lib/zk_prover/public_inputs";

const SYNTHETIC_PUBLIC_JSON =
  "tests/fixtures/zk/withdraw_sol_v1/synthetic_public_json_shape.json";
const VECTOR_PATH = "tests/fixtures/zk/withdraw_sol_v1/public_test_vector.json";
const LOCKED_TX_HASH =
  "17115e272898a4cca8177791e2e99f51b2e01e7bc2d1381164217f6ef931bcac";
const LOCKED_TX_HASH_DEC =
  "10433881737386163460470444104344813805287698727706633656158202324469777808556";
const ZERO_HEX = "0".repeat(64);
const ONE_HEX = "0".repeat(63) + "1";

describe("zk_public_inputs_shape: public input normalization", function () {
  // ── constants ───────────────────────────────────────────────────────────────

  describe("constants", function () {
    it("PUBLIC_INPUTS_ORDER is ['root', 'nullifier_hash', 'tx_hash']", () => {
      expect(WITHDRAW_SOL_V1_PUBLIC_INPUTS_ORDER).to.deep.equal([
        "root",
        "nullifier_hash",
        "tx_hash",
      ]);
    });

    it("PUBLIC_INPUTS_ORDER has length 3", () => {
      expect(WITHDRAW_SOL_V1_PUBLIC_INPUTS_ORDER).to.have.length(3);
    });
  });

  // ── bigintToHex32BE ─────────────────────────────────────────────────────────

  describe("bigintToHex32BE", function () {
    it("0n returns 64 zeros", () => {
      expect(bigintToHex32BE(0n)).to.equal(ZERO_HEX);
    });

    it("1n returns 63 zeros + '1'", () => {
      expect(bigintToHex32BE(1n)).to.equal(ONE_HEX);
    });

    it("255n ends with 'ff'", () => {
      const result = bigintToHex32BE(255n);
      expect(result).to.have.length(64);
      expect(result.slice(-2)).to.equal("ff");
    });

    it("256n ends with '0100'", () => {
      const result = bigintToHex32BE(256n);
      expect(result).to.have.length(64);
      expect(result.slice(-4)).to.equal("0100");
    });

    it("locked tx_hash bigint round-trips to correct hex", () => {
      const v = BigInt("0x" + LOCKED_TX_HASH);
      expect(bigintToHex32BE(v)).to.equal(LOCKED_TX_HASH);
    });

    it("result is always exactly 64 chars", () => {
      expect(bigintToHex32BE(0n)).to.have.length(64);
      expect(bigintToHex32BE(1n)).to.have.length(64);
      expect(bigintToHex32BE(2n ** 255n)).to.have.length(64);
    });

    it("result is lowercase hex", () => {
      const result = bigintToHex32BE(BigInt("0x" + LOCKED_TX_HASH));
      expect(result).to.match(/^[0-9a-f]{64}$/);
    });

    it("throws on negative bigint", () => {
      expect(() => bigintToHex32BE(-1n)).to.throw(/non-negative/);
    });

    it("throws on 2n ** 256n", () => {
      expect(() => bigintToHex32BE(2n ** 256n)).to.throw(/exceeds/);
    });
  });

  // ── decimalStringToHex32BE ──────────────────────────────────────────────────

  describe("decimalStringToHex32BE", function () {
    it('"0" -> 64 zeros', () => {
      expect(decimalStringToHex32BE("0")).to.equal(ZERO_HEX);
    });

    it('"1" -> 63 zeros + "1"', () => {
      expect(decimalStringToHex32BE("1")).to.equal(ONE_HEX);
    });

    it("decimal form of locked tx_hash -> correct hex", () => {
      expect(decimalStringToHex32BE(LOCKED_TX_HASH_DEC)).to.equal(
        LOCKED_TX_HASH
      );
    });

    it("rejects empty string", () => {
      expect(() => decimalStringToHex32BE("")).to.throw();
    });

    it('rejects " 1" (leading space)', () => {
      expect(() => decimalStringToHex32BE(" 1")).to.throw();
    });

    it('rejects "1 " (trailing space)', () => {
      expect(() => decimalStringToHex32BE("1 ")).to.throw();
    });

    it('rejects "-1" (negative)', () => {
      expect(() => decimalStringToHex32BE("-1")).to.throw();
    });

    it('rejects "1.5" (float)', () => {
      expect(() => decimalStringToHex32BE("1.5")).to.throw();
    });

    it('rejects "0x10" (hex prefix)', () => {
      expect(() => decimalStringToHex32BE("0x10")).to.throw();
    });

    it('rejects "abc" (non-numeric)', () => {
      expect(() => decimalStringToHex32BE("abc")).to.throw();
    });
  });

  // ── normalizeSnarkjsPublicJson ──────────────────────────────────────────────

  describe("normalizeSnarkjsPublicJson: shape", function () {
    const syntheticInput = ["0", "0", LOCKED_TX_HASH_DEC];

    it("returns object with root_be_hex, nullifier_hash_be_hex, tx_hash_be_hex", () => {
      const result = normalizeSnarkjsPublicJson(syntheticInput);
      expect(result).to.have.keys([
        "root_be_hex",
        "nullifier_hash_be_hex",
        "tx_hash_be_hex",
      ]);
    });

    it("root_be_hex is zero hex for input '0'", () => {
      const result = normalizeSnarkjsPublicJson(syntheticInput);
      expect(result.root_be_hex).to.equal(ZERO_HEX);
    });

    it("nullifier_hash_be_hex is zero hex for input '0'", () => {
      const result = normalizeSnarkjsPublicJson(syntheticInput);
      expect(result.nullifier_hash_be_hex).to.equal(ZERO_HEX);
    });

    it("tx_hash_be_hex equals locked tx_hash hex", () => {
      const result = normalizeSnarkjsPublicJson(syntheticInput);
      expect(result.tx_hash_be_hex).to.equal(LOCKED_TX_HASH);
    });

    it("all hex fields are exactly 64 chars", () => {
      const result = normalizeSnarkjsPublicJson(syntheticInput);
      expect(result.root_be_hex).to.have.length(64);
      expect(result.nullifier_hash_be_hex).to.have.length(64);
      expect(result.tx_hash_be_hex).to.have.length(64);
    });
  });

  describe("normalizeSnarkjsPublicJson: rejection", function () {
    it("rejects non-array (object)", () => {
      expect(() => normalizeSnarkjsPublicJson({ a: "0" })).to.throw(/array/);
    });

    it("rejects non-array (string)", () => {
      expect(() => normalizeSnarkjsPublicJson("0,0,0")).to.throw(/array/);
    });

    it("rejects array of length 2", () => {
      expect(() => normalizeSnarkjsPublicJson(["0", "0"])).to.throw(/length/);
    });

    it("rejects array of length 4", () => {
      expect(() => normalizeSnarkjsPublicJson(["0", "0", "0", "0"])).to.throw(
        /length/
      );
    });

    it("rejects non-string element (number)", () => {
      expect(() => normalizeSnarkjsPublicJson([0, "0", "0"])).to.throw(
        /string/
      );
    });

    it("rejects negative decimal element", () => {
      expect(() => normalizeSnarkjsPublicJson(["-1", "0", "0"])).to.throw();
    });

    it("rejects hex-prefixed element", () => {
      expect(() => normalizeSnarkjsPublicJson(["0x10", "0", "0"])).to.throw();
    });

    it("rejects whitespace-padded element", () => {
      expect(() => normalizeSnarkjsPublicJson([" 0", "0", "0"])).to.throw();
    });
  });

  // ── synthetic fixture load ──────────────────────────────────────────────────

  describe("synthetic fixture load", function () {
    it("loadSnarkjsPublicJson loads the synthetic fixture without throwing", () => {
      expect(() => loadSnarkjsPublicJson(SYNTHETIC_PUBLIC_JSON)).to.not.throw();
    });

    it("loadSnarkjsPublicJson returns an array", () => {
      const result = loadSnarkjsPublicJson(SYNTHETIC_PUBLIC_JSON);
      expect(Array.isArray(result)).to.be.true;
    });

    it("loadAndNormalizeSnarkjsPublicJson succeeds on synthetic fixture", () => {
      const result = loadAndNormalizeSnarkjsPublicJson(SYNTHETIC_PUBLIC_JSON);
      expect(result).to.be.an("object");
    });

    it("normalized root from synthetic fixture matches real root", () => {
      const result = loadAndNormalizeSnarkjsPublicJson(SYNTHETIC_PUBLIC_JSON);
      expect(result.root_be_hex).to.equal(
        "019484fc7e68257f3bbfbd277beabb5a6082bc0dd6f96154bdebde0b81b72f38"
      );
    });

    it("normalized nullifier_hash from synthetic fixture matches real nullifier_hash", () => {
      const result = loadAndNormalizeSnarkjsPublicJson(SYNTHETIC_PUBLIC_JSON);
      expect(result.nullifier_hash_be_hex).to.equal(
        "27cb78d0541f3912c8645bd60acbe7a7205225e0e6f55a17f4843ac719e3eafe"
      );
    });

    it("normalized tx_hash from synthetic fixture equals locked tx_hash", () => {
      const result = loadAndNormalizeSnarkjsPublicJson(SYNTHETIC_PUBLIC_JSON);
      expect(result.tx_hash_be_hex).to.equal(LOCKED_TX_HASH);
    });

    it("throws on non-existent file with readable error", () => {
      expect(() =>
        loadSnarkjsPublicJson("tests/fixtures/zk/does_not_exist.json")
      ).to.throw(/cannot read/i);
    });
  });

  // ── comparePublicInputsToVector ─────────────────────────────────────────────

  describe("comparePublicInputsToVector", function () {
    const syntheticNormalized: NormalizedPublicInputs = {
      root_be_hex: ZERO_HEX,
      nullifier_hash_be_hex: ZERO_HEX,
      tx_hash_be_hex: LOCKED_TX_HASH,
    };

    const validVector = {
      public_inputs_order: ["root", "nullifier_hash", "tx_hash"] as string[],
      root_be_hex: ZERO_HEX,
      nullifier_hash_be_hex: ZERO_HEX,
      tx_hash_be_hex: LOCKED_TX_HASH,
    };

    it("matching inputs return ok: true", () => {
      const result = comparePublicInputsToVector(
        syntheticNormalized,
        validVector
      );
      expect(result.ok).to.be.true;
    });

    it("matching inputs have empty mismatches list", () => {
      const result = comparePublicInputsToVector(
        syntheticNormalized,
        validVector
      );
      expect(result.mismatches).to.have.length(0);
    });

    it("mismatch on root returns ok: false", () => {
      const actual: NormalizedPublicInputs = {
        ...syntheticNormalized,
        root_be_hex: ONE_HEX,
      };
      const result = comparePublicInputsToVector(actual, validVector);
      expect(result.ok).to.be.false;
    });

    it("mismatch on root includes 'root_be_hex' in mismatches", () => {
      const actual: NormalizedPublicInputs = {
        ...syntheticNormalized,
        root_be_hex: ONE_HEX,
      };
      const result = comparePublicInputsToVector(actual, validVector);
      expect(result.mismatches).to.include("root_be_hex");
    });

    it("mismatch on nullifier_hash returns ok: false", () => {
      const actual: NormalizedPublicInputs = {
        ...syntheticNormalized,
        nullifier_hash_be_hex: ONE_HEX,
      };
      const result = comparePublicInputsToVector(actual, validVector);
      expect(result.ok).to.be.false;
    });

    it("mismatch on nullifier_hash includes 'nullifier_hash_be_hex' in mismatches", () => {
      const actual: NormalizedPublicInputs = {
        ...syntheticNormalized,
        nullifier_hash_be_hex: ONE_HEX,
      };
      const result = comparePublicInputsToVector(actual, validVector);
      expect(result.mismatches).to.include("nullifier_hash_be_hex");
    });

    it("mismatch on tx_hash returns ok: false", () => {
      const actual: NormalizedPublicInputs = {
        ...syntheticNormalized,
        tx_hash_be_hex: ZERO_HEX,
      };
      const result = comparePublicInputsToVector(actual, validVector);
      expect(result.ok).to.be.false;
    });

    it("mismatch on tx_hash includes 'tx_hash_be_hex' in mismatches", () => {
      const actual: NormalizedPublicInputs = {
        ...syntheticNormalized,
        tx_hash_be_hex: ZERO_HEX,
      };
      const result = comparePublicInputsToVector(actual, validVector);
      expect(result.mismatches).to.include("tx_hash_be_hex");
    });

    it("comparison result includes expected and actual fields", () => {
      const result = comparePublicInputsToVector(
        syntheticNormalized,
        validVector
      );
      expect(result).to.have.keys(["ok", "expected", "actual", "mismatches"]);
    });

    it("malformed vector order throws", () => {
      const badVector = {
        ...validVector,
        public_inputs_order: ["nullifier_hash", "root", "tx_hash"],
      };
      expect(() =>
        comparePublicInputsToVector(syntheticNormalized, badVector)
      ).to.throw(/public_inputs_order/);
    });

    it("vector order must exactly equal ['root', 'nullifier_hash', 'tx_hash']", () => {
      const badVector = {
        ...validVector,
        public_inputs_order: ["root", "tx_hash", "nullifier_hash"],
      };
      expect(() =>
        comparePublicInputsToVector(syntheticNormalized, badVector)
      ).to.throw();
    });
  });

  // ── loadAndComparePublicInputs ──────────────────────────────────────────────

  describe("loadAndComparePublicInputs", function () {
    it("synthetic fixture vs test vector returns ok: true", () => {
      const result = loadAndComparePublicInputs(
        SYNTHETIC_PUBLIC_JSON,
        VECTOR_PATH
      );
      expect(result.ok).to.be.true;
    });

    it("synthetic fixture vs test vector has no mismatches", () => {
      const result = loadAndComparePublicInputs(
        SYNTHETIC_PUBLIC_JSON,
        VECTOR_PATH
      );
      expect(result.mismatches).to.have.length(0);
    });

    it("throws on missing public.json with readable error", () => {
      expect(() =>
        loadAndComparePublicInputs(
          "tests/fixtures/zk/missing.json",
          VECTOR_PATH
        )
      ).to.throw(/cannot read/i);
    });

    it("throws on missing vector file with readable error", () => {
      expect(() =>
        loadAndComparePublicInputs(
          SYNTHETIC_PUBLIC_JSON,
          "tests/fixtures/zk/missing_vector.json"
        )
      ).to.throw(/cannot load vector/i);
    });
  });

  // ── formatPublicInputComparison ─────────────────────────────────────────────

  describe("formatPublicInputComparison", function () {
    it("PASS result contains 'PASS'", () => {
      const result = loadAndComparePublicInputs(
        SYNTHETIC_PUBLIC_JSON,
        VECTOR_PATH
      );
      expect(formatPublicInputComparison(result)).to.include("PASS");
    });

    it("PASS result does not contain 'FAIL'", () => {
      const result = loadAndComparePublicInputs(
        SYNTHETIC_PUBLIC_JSON,
        VECTOR_PATH
      );
      expect(formatPublicInputComparison(result)).to.not.include("FAIL");
    });

    it("FAIL result contains 'FAIL'", () => {
      const actual: NormalizedPublicInputs = {
        root_be_hex: ONE_HEX,
        nullifier_hash_be_hex: ZERO_HEX,
        tx_hash_be_hex: LOCKED_TX_HASH,
      };
      const result = comparePublicInputsToVector(actual, {
        public_inputs_order: ["root", "nullifier_hash", "tx_hash"],
        root_be_hex: ZERO_HEX,
        nullifier_hash_be_hex: ZERO_HEX,
        tx_hash_be_hex: LOCKED_TX_HASH,
      });
      expect(formatPublicInputComparison(result)).to.include("FAIL");
    });

    it("FAIL result includes mismatch field name", () => {
      const actual: NormalizedPublicInputs = {
        root_be_hex: ONE_HEX,
        nullifier_hash_be_hex: ZERO_HEX,
        tx_hash_be_hex: LOCKED_TX_HASH,
      };
      const result = comparePublicInputsToVector(actual, {
        public_inputs_order: ["root", "nullifier_hash", "tx_hash"],
        root_be_hex: ZERO_HEX,
        nullifier_hash_be_hex: ZERO_HEX,
        tx_hash_be_hex: LOCKED_TX_HASH,
      });
      expect(formatPublicInputComparison(result)).to.include("root_be_hex");
    });

    it("FAIL result with multiple mismatches includes all field names", () => {
      const actual: NormalizedPublicInputs = {
        root_be_hex: ONE_HEX,
        nullifier_hash_be_hex: ONE_HEX,
        tx_hash_be_hex: ZERO_HEX,
      };
      const result = comparePublicInputsToVector(actual, {
        public_inputs_order: ["root", "nullifier_hash", "tx_hash"],
        root_be_hex: ZERO_HEX,
        nullifier_hash_be_hex: ZERO_HEX,
        tx_hash_be_hex: LOCKED_TX_HASH,
      });
      const formatted = formatPublicInputComparison(result);
      expect(formatted).to.include("root_be_hex");
      expect(formatted).to.include("nullifier_hash_be_hex");
      expect(formatted).to.include("tx_hash_be_hex");
    });
  });
});
