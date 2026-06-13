// Shape and serialization tests for lib/zk_prover/proof_encoder.ts.
//
// These are encoding correctness tests ONLY. They do NOT perform cryptographic
// proof verification. They do NOT assert that any proof is valid for any circuit.
// They pin the byte layout decisions (field membership, endianness, coordinate order,
// proof_a.y negation) with synthetic vectors.

import { expect } from "chai";
import type { ZkProofJson } from "../lib/zk_prover/fixture";
import {
  BN254_FQ_MODULUS_DEC,
  BN254_FR_MODULUS_DEC,
  decimalStringToBigIntStrict,
  bigintToBytes32BE,
  validateFq,
  negateFq,
  encodeSnarkjsGroth16Proof,
  loadAndEncodeSnarkjsGroth16Proof,
} from "../lib/zk_prover/proof_encoder";

const SYNTHETIC_FIXTURE_PATH =
  "tests/fixtures/zk/withdraw_sol_v1/synthetic_snarkjs_proof_shape.json";

const BN254_FQ = BigInt(BN254_FQ_MODULUS_DEC);

// Helper: convert bigint to 32 BE bytes
function bytes32(value: bigint): number[] {
  return bigintToBytes32BE(value);
}

// Helper: build a mutable valid minimal proof object
function syntheticProof(overrides: Partial<ZkProofJson> = {}): ZkProofJson {
  return {
    pi_a: ["1", "2", "1"],
    pi_b: [
      ["10", "20"],
      ["30", "40"],
      ["1", "0"],
    ],
    pi_c: ["100", "200", "1"],
    protocol: "groth16",
    curve: "bn128",
    ...overrides,
  };
}

describe("zk_proof_encoder_shape: encoding shape tests — NOT cryptographic proof verification", function () {
  // ── Constants ───────────────────────────────────────────────────────────────

  describe("constants", function () {
    it("BN254_FQ_MODULUS_DEC and BN254_FR_MODULUS_DEC are distinct", function () {
      expect(BN254_FQ_MODULUS_DEC).to.not.equal(BN254_FR_MODULUS_DEC);
    });

    it("BN254_FQ_MODULUS_DEC is a decimal string", function () {
      expect(/^[0-9]+$/.test(BN254_FQ_MODULUS_DEC)).to.be.true;
    });

    it("BN254_FR_MODULUS_DEC is a decimal string", function () {
      expect(/^[0-9]+$/.test(BN254_FR_MODULUS_DEC)).to.be.true;
    });
  });

  // ── decimalStringToBigIntStrict ─────────────────────────────────────────────

  describe("decimalStringToBigIntStrict", function () {
    it('accepts "0" -> 0n', function () {
      expect(decimalStringToBigIntStrict("0")).to.equal(0n);
    });

    it('accepts "1" -> 1n', function () {
      expect(decimalStringToBigIntStrict("1")).to.equal(1n);
    });

    it("accepts the largest Fr field element (Fr - 1)", function () {
      const frMinusOne = (BigInt(BN254_FR_MODULUS_DEC) - 1n).toString();
      expect(decimalStringToBigIntStrict(frMinusOne)).to.equal(
        BigInt(BN254_FR_MODULUS_DEC) - 1n
      );
    });

    it('rejects ""', function () {
      expect(() => decimalStringToBigIntStrict("")).to.throw();
    });

    it('rejects "abc"', function () {
      expect(() => decimalStringToBigIntStrict("abc")).to.throw();
    });

    it('rejects "-1"', function () {
      expect(() => decimalStringToBigIntStrict("-1")).to.throw();
    });

    it('rejects "1.5"', function () {
      expect(() => decimalStringToBigIntStrict("1.5")).to.throw();
    });

    it('rejects "0x10"', function () {
      expect(() => decimalStringToBigIntStrict("0x10")).to.throw();
    });

    it('rejects " 42" (leading space)', function () {
      expect(() => decimalStringToBigIntStrict(" 42")).to.throw();
    });

    it('rejects "42 " (trailing space)', function () {
      expect(() => decimalStringToBigIntStrict("42 ")).to.throw();
    });
  });

  // ── bigintToBytes32BE ───────────────────────────────────────────────────────

  describe("bigintToBytes32BE", function () {
    it("0n returns 32 zeros", function () {
      const result = bigintToBytes32BE(0n);
      expect(result).to.have.lengthOf(32);
      expect(result.every((b) => b === 0)).to.be.true;
    });

    it("1n returns 32 bytes with last byte = 1 (big-endian)", function () {
      const result = bigintToBytes32BE(1n);
      expect(result).to.have.lengthOf(32);
      expect(result[31]).to.equal(1);
      expect(result.slice(0, 31).every((b) => b === 0)).to.be.true;
    });

    it("256n returns last two bytes [1, 0]", function () {
      const result = bigintToBytes32BE(256n);
      expect(result).to.have.lengthOf(32);
      expect(result[30]).to.equal(1);
      expect(result[31]).to.equal(0);
      expect(result.slice(0, 30).every((b) => b === 0)).to.be.true;
    });

    it("returns exactly 32 elements", function () {
      expect(bigintToBytes32BE(42n)).to.have.lengthOf(32);
    });

    it("2n**256n - 1n returns 32 bytes all 255", function () {
      const result = bigintToBytes32BE(2n ** 256n - 1n);
      expect(result).to.have.lengthOf(32);
      expect(result.every((b) => b === 255)).to.be.true;
    });

    it("throws for 2n**256n (overflow)", function () {
      expect(() => bigintToBytes32BE(2n ** 256n)).to.throw();
    });

    it("throws for -1n (negative)", function () {
      expect(() => bigintToBytes32BE(-1n)).to.throw();
    });
  });

  // ── validateFq ─────────────────────────────────────────────────────────────

  describe("validateFq", function () {
    it("accepts 0n", function () {
      expect(validateFq(0n, "test")).to.equal(0n);
    });

    it("accepts Fq - 1n", function () {
      const v = BN254_FQ - 1n;
      expect(validateFq(v, "test")).to.equal(v);
    });

    it("rejects Fq (equals modulus)", function () {
      expect(() => validateFq(BN254_FQ, "test")).to.throw();
    });

    it("rejects -1n (negative)", function () {
      expect(() => validateFq(-1n, "test")).to.throw();
    });
  });

  // ── negateFq ───────────────────────────────────────────────────────────────

  describe("negateFq", function () {
    it("negateFq(0n) === 0n", function () {
      expect(negateFq(0n)).to.equal(0n);
    });

    it("negateFq(1n) === Fq - 1n", function () {
      expect(negateFq(1n)).to.equal(BN254_FQ - 1n);
    });

    it("negateFq(Fq - 1n) === 1n", function () {
      expect(negateFq(BN254_FQ - 1n)).to.equal(1n);
    });

    it("rejects Fq (not a valid field element)", function () {
      expect(() => negateFq(BN254_FQ)).to.throw();
    });
  });

  // ── encodeSnarkjsGroth16Proof: output shapes ────────────────────────────────

  describe("encodeSnarkjsGroth16Proof shape", function () {
    it("proofA.length === 64", function () {
      const { proofA } = encodeSnarkjsGroth16Proof(syntheticProof());
      expect(proofA).to.have.lengthOf(64);
    });

    it("proofB.length === 128", function () {
      const { proofB } = encodeSnarkjsGroth16Proof(syntheticProof());
      expect(proofB).to.have.lengthOf(128);
    });

    it("proofC.length === 64", function () {
      const { proofC } = encodeSnarkjsGroth16Proof(syntheticProof());
      expect(proofC).to.have.lengthOf(64);
    });

    it("all elements in all proof arrays are integers in [0, 255]", function () {
      const { proofA, proofB, proofC } = encodeSnarkjsGroth16Proof(
        syntheticProof()
      );
      const all = [...proofA, ...proofB, ...proofC];
      expect(all.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).to.be
        .true;
    });
  });

  // ── encodeSnarkjsGroth16Proof: rejections ────────────────────────────────────

  describe("encodeSnarkjsGroth16Proof rejections", function () {
    it('rejects protocol: "plonk"', function () {
      expect(() =>
        encodeSnarkjsGroth16Proof(
          syntheticProof({ protocol: "plonk" as "groth16" })
        )
      ).to.throw(/protocol/);
    });

    it('rejects curve: "bls12-381"', function () {
      expect(() =>
        encodeSnarkjsGroth16Proof(
          syntheticProof({ curve: "bls12-381" as "bn128" })
        )
      ).to.throw(/curve/);
    });

    it('rejects pi_a[2] !== "1"', function () {
      const p = syntheticProof();
      p.pi_a = ["1", "2", "2"];
      expect(() => encodeSnarkjsGroth16Proof(p)).to.throw(/pi_a\[2\]/);
    });

    it('rejects pi_b[2] !== ["1", "0"]', function () {
      const p = syntheticProof();
      p.pi_b = [
        ["10", "20"],
        ["30", "40"],
        ["0", "1"],
      ];
      expect(() => encodeSnarkjsGroth16Proof(p)).to.throw(/pi_b\[2\]/);
    });

    it('rejects pi_c[2] !== "1"', function () {
      const p = syntheticProof();
      p.pi_c = ["100", "200", "2"];
      expect(() => encodeSnarkjsGroth16Proof(p)).to.throw(/pi_c\[2\]/);
    });

    it('rejects pi_a[0] = "xyz" (non-decimal)', function () {
      const p = syntheticProof();
      p.pi_a = ["xyz", "2", "1"];
      expect(() => encodeSnarkjsGroth16Proof(p)).to.throw();
    });

    it('rejects pi_a[1] = "-1" (negative)', function () {
      const p = syntheticProof();
      p.pi_a = ["1", "-1", "1"];
      expect(() => encodeSnarkjsGroth16Proof(p)).to.throw();
    });

    it("rejects coordinate equal to BN254_FQ_MODULUS_DEC (out of field)", function () {
      const p = syntheticProof();
      p.pi_a = [BN254_FQ_MODULUS_DEC, "1", "1"];
      expect(() => encodeSnarkjsGroth16Proof(p)).to.throw(/Fq/);
    });
  });

  // ── proof_a y-negation pinning ──────────────────────────────────────────────
  //
  // Encoding shape test: confirms proof_a uses Fq negation for y-coordinate.
  // This is NOT a test of cryptographic proof validity.

  describe("proof_a y-negation pinning (encoding shape, not proof validity)", function () {
    it("proof_a[0..32] equals bigintToBytes32BE(5n) — x unchanged", function () {
      const p = syntheticProof({ pi_a: ["5", "7", "1"] });
      const { proofA } = encodeSnarkjsGroth16Proof(p);
      expect(proofA.slice(0, 32)).to.deep.equal(bytes32(5n));
    });

    it("proof_a[32..64] equals bigintToBytes32BE(negateFq(7n)) — y negated over Fq", function () {
      const p = syntheticProof({ pi_a: ["5", "7", "1"] });
      const { proofA } = encodeSnarkjsGroth16Proof(p);
      expect(proofA.slice(32, 64)).to.deep.equal(bytes32(negateFq(7n)));
    });
  });

  // ── proof_b coordinate order pinning ────────────────────────────────────────
  //
  // This pins the EIP-197 / groth16-solana coordinate order derived from VK
  // parsing analysis. snarkjs pi_b[i] = [c0, c1] (real first, imaginary second);
  // groth16-solana / EIP-197 expects imaginary (c1) first, then real (c0).
  //
  // Must be verified end-to-end with real circuit output before production reliance.

  describe("proof_b coordinate order pinning (EIP-197, unconfirmed against real circuit output)", function () {
    // Synthetic vector: pi_b[0] = ["10", "20"], pi_b[1] = ["30", "40"]
    // Expected proof_b layout:
    //   [0..32]   = 20 BE  (pi_b[0][1] = x.c1)
    //   [32..64]  = 10 BE  (pi_b[0][0] = x.c0)
    //   [64..96]  = 40 BE  (pi_b[1][1] = y.c1)
    //   [96..128] = 30 BE  (pi_b[1][0] = y.c0)

    it("proof_b[0..32] = pi_b[0][1] = 20 as 32 BE bytes (x.c1, imaginary first)", function () {
      const { proofB } = encodeSnarkjsGroth16Proof(syntheticProof());
      expect(proofB.slice(0, 32)).to.deep.equal(bytes32(20n));
    });

    it("proof_b[32..64] = pi_b[0][0] = 10 as 32 BE bytes (x.c0, real second)", function () {
      const { proofB } = encodeSnarkjsGroth16Proof(syntheticProof());
      expect(proofB.slice(32, 64)).to.deep.equal(bytes32(10n));
    });

    it("proof_b[64..96] = pi_b[1][1] = 40 as 32 BE bytes (y.c1, imaginary first)", function () {
      const { proofB } = encodeSnarkjsGroth16Proof(syntheticProof());
      expect(proofB.slice(64, 96)).to.deep.equal(bytes32(40n));
    });

    it("proof_b[96..128] = pi_b[1][0] = 30 as 32 BE bytes (y.c0, real second)", function () {
      const { proofB } = encodeSnarkjsGroth16Proof(syntheticProof());
      expect(proofB.slice(96, 128)).to.deep.equal(bytes32(30n));
    });
  });

  // ── proof_c no-negation ─────────────────────────────────────────────────────

  describe("proof_c no-negation (encoding shape, not proof validity)", function () {
    it("proof_c[0..32] equals bigintToBytes32BE(100n) — x unchanged", function () {
      const { proofC } = encodeSnarkjsGroth16Proof(syntheticProof());
      expect(proofC.slice(0, 32)).to.deep.equal(bytes32(100n));
    });

    it("proof_c[32..64] equals bigintToBytes32BE(200n) — y not negated", function () {
      const { proofC } = encodeSnarkjsGroth16Proof(syntheticProof());
      expect(proofC.slice(32, 64)).to.deep.equal(bytes32(200n));
    });
  });

  // ── loadAndEncodeSnarkjsGroth16Proof ────────────────────────────────────────

  describe("loadAndEncodeSnarkjsGroth16Proof", function () {
    it("loads synthetic fixture and returns proofA length 64", function () {
      const { proofA } = loadAndEncodeSnarkjsGroth16Proof(
        SYNTHETIC_FIXTURE_PATH
      );
      expect(proofA).to.have.lengthOf(64);
    });

    it("loads synthetic fixture and returns proofB length 128", function () {
      const { proofB } = loadAndEncodeSnarkjsGroth16Proof(
        SYNTHETIC_FIXTURE_PATH
      );
      expect(proofB).to.have.lengthOf(128);
    });

    it("loads synthetic fixture and returns proofC length 64", function () {
      const { proofC } = loadAndEncodeSnarkjsGroth16Proof(
        SYNTHETIC_FIXTURE_PATH
      );
      expect(proofC).to.have.lengthOf(64);
    });

    it("loaded proofB matches expected coordinate order (20, 10, 40, 30)", function () {
      // Synthetic fixture: pi_b[0]=["10","20"], pi_b[1]=["30","40"]
      // EIP-197 order: c1 first, c0 second per coordinate
      const { proofB } = loadAndEncodeSnarkjsGroth16Proof(
        SYNTHETIC_FIXTURE_PATH
      );
      expect(proofB.slice(0, 32)).to.deep.equal(bytes32(20n)); // x.c1
      expect(proofB.slice(32, 64)).to.deep.equal(bytes32(10n)); // x.c0
      expect(proofB.slice(64, 96)).to.deep.equal(bytes32(40n)); // y.c1
      expect(proofB.slice(96, 128)).to.deep.equal(bytes32(30n)); // y.c0
    });

    it("loaded proofA applies negateFq to pi_a[1]=2", function () {
      // Synthetic fixture: pi_a = ["1", "2", "1"]
      // Expected: proofA[0..32] = bytes32(1n), proofA[32..64] = bytes32(negateFq(2n))
      const { proofA } = loadAndEncodeSnarkjsGroth16Proof(
        SYNTHETIC_FIXTURE_PATH
      );
      expect(proofA.slice(0, 32)).to.deep.equal(bytes32(1n));
      expect(proofA.slice(32, 64)).to.deep.equal(bytes32(negateFq(2n)));
    });

    it("throws on non-existent file", function () {
      expect(() =>
        loadAndEncodeSnarkjsGroth16Proof(
          "tests/fixtures/zk/does_not_exist.json"
        )
      ).to.throw();
    });
  });
});
