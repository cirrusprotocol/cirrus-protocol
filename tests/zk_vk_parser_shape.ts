// Shape and serialization tests for lib/zk_prover/vk_parser.ts.
//
// These are encoding correctness tests ONLY. They do NOT perform cryptographic
// proof verification. They do NOT assert that any VK is valid for any circuit.
// They pin the byte layout decisions (field membership, endianness, coordinate
// order, no y-negation for VK G1 points) with synthetic vectors.

import { expect } from "chai";
import {
  WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT,
  WITHDRAW_SOL_V1_VK_IC_LENGTH,
  encodeSnarkjsG1Point,
  encodeSnarkjsG2Point,
  encodeSnarkjsGroth16VerificationKey,
  loadAndEncodeSnarkjsGroth16VerificationKey,
  formatRustVkPreview,
  SnarkjsGroth16VerificationKeyJson,
} from "../lib/zk_prover/vk_parser";
import {
  bigintToBytes32BE,
  negateFq,
  BN254_FQ_MODULUS_DEC,
} from "../lib/zk_prover/proof_encoder";

const SYNTHETIC_VK_PATH =
  "tests/fixtures/zk/withdraw_sol_v1/synthetic_verification_key_shape.json";

// Helper: 32-byte BE encoding
function bytes32(value: bigint): number[] {
  return bigintToBytes32BE(value);
}

// Helper: build a minimal valid synthetic VK object
function syntheticVk(
  overrides: Partial<SnarkjsGroth16VerificationKeyJson> = {}
): SnarkjsGroth16VerificationKeyJson {
  return {
    protocol: "groth16",
    curve: "bn128",
    nPublic: 3,
    vk_alpha_1: ["1", "2", "1"],
    vk_beta_2: [
      ["10", "20"],
      ["30", "40"],
      ["1", "0"],
    ],
    vk_gamma_2: [
      ["50", "60"],
      ["70", "80"],
      ["1", "0"],
    ],
    vk_delta_2: [
      ["90", "100"],
      ["110", "120"],
      ["1", "0"],
    ],
    IC: [
      ["1000", "1001", "1"],
      ["1002", "1003", "1"],
      ["1004", "1005", "1"],
      ["1006", "1007", "1"],
    ],
    ...overrides,
  };
}

describe("zk_vk_parser_shape: encoding shape tests — NOT cryptographic VK verification", function () {
  // ── Constants ─────────────────────────────────────────────────────────────

  describe("constants", function () {
    it("WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT is 3", function () {
      expect(WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT).to.equal(3);
    });

    it("WITHDRAW_SOL_V1_VK_IC_LENGTH is 4", function () {
      expect(WITHDRAW_SOL_V1_VK_IC_LENGTH).to.equal(4);
    });

    it("VK_IC_LENGTH equals PUBLIC_INPUT_COUNT + 1", function () {
      expect(WITHDRAW_SOL_V1_VK_IC_LENGTH).to.equal(
        WITHDRAW_SOL_V1_PUBLIC_INPUT_COUNT + 1
      );
    });
  });

  // ── Fixture load ──────────────────────────────────────────────────────────

  describe("synthetic fixture load", function () {
    it("loads synthetic VK fixture without throwing", function () {
      const vk = loadAndEncodeSnarkjsGroth16VerificationKey(SYNTHETIC_VK_PATH);
      expect(vk).to.be.an("object");
    });

    it("loaded fixture has nrPubinputs 4", function () {
      const vk = loadAndEncodeSnarkjsGroth16VerificationKey(SYNTHETIC_VK_PATH);
      expect(vk.nrPubinputs).to.equal(4);
    });

    it("loaded raw fixture protocol is groth16", function () {
      // Validate the fixture JSON itself has the expected fields
      const raw = require("../tests/fixtures/zk/withdraw_sol_v1/synthetic_verification_key_shape.json");
      expect(raw.protocol).to.equal("groth16");
    });

    it("loaded raw fixture curve is bn128", function () {
      const raw = require("../tests/fixtures/zk/withdraw_sol_v1/synthetic_verification_key_shape.json");
      expect(raw.curve).to.equal("bn128");
    });

    it("loaded raw fixture nPublic is 3", function () {
      const raw = require("../tests/fixtures/zk/withdraw_sol_v1/synthetic_verification_key_shape.json");
      expect(raw.nPublic).to.equal(3);
    });

    it("loaded raw fixture IC length is 4", function () {
      const raw = require("../tests/fixtures/zk/withdraw_sol_v1/synthetic_verification_key_shape.json");
      expect(raw.IC).to.be.an("array").with.lengthOf(4);
    });
  });

  // ── G1 encoding ───────────────────────────────────────────────────────────

  describe('encodeSnarkjsG1Point (vk_alpha_1 = ["1","2","1"])', function () {
    const g1Input = ["1", "2", "1"];

    it("returns 64 bytes", function () {
      const result = encodeSnarkjsG1Point(g1Input, "test_g1");
      expect(result).to.have.lengthOf(64);
    });

    it("first 32 bytes equal bigintToBytes32BE(1n) — x coordinate", function () {
      const result = encodeSnarkjsG1Point(g1Input, "test_g1");
      expect(result.slice(0, 32)).to.deep.equal(bytes32(1n));
    });

    it("second 32 bytes equal bigintToBytes32BE(2n) — y coordinate not negated", function () {
      const result = encodeSnarkjsG1Point(g1Input, "test_g1");
      expect(result.slice(32, 64)).to.deep.equal(bytes32(2n));
    });

    it("no y-negation for VK G1 points (differs from proof_a in proof_encoder)", function () {
      const result = encodeSnarkjsG1Point(g1Input, "test_g1");
      const negated2 = negateFq(2n);
      // Second 32 bytes should NOT be the negated value
      expect(result.slice(32, 64)).to.not.deep.equal(bytes32(negated2));
      // Second 32 bytes should be the plain value
      expect(result.slice(32, 64)).to.deep.equal(bytes32(2n));
    });
  });

  // ── G2 encoding ───────────────────────────────────────────────────────────

  describe('encodeSnarkjsG2Point (vk_beta_2 = [["10","20"],["30","40"],["1","0"]])', function () {
    const g2Input = [
      ["10", "20"],
      ["30", "40"],
      ["1", "0"],
    ];

    it("returns 128 bytes", function () {
      const result = encodeSnarkjsG2Point(g2Input, "test_g2");
      expect(result).to.have.lengthOf(128);
    });

    it("bytes[0..32] = x.c1_BE = bigintToBytes32BE(20n)", function () {
      const result = encodeSnarkjsG2Point(g2Input, "test_g2");
      expect(result.slice(0, 32)).to.deep.equal(bytes32(20n));
    });

    it("bytes[32..64] = x.c0_BE = bigintToBytes32BE(10n)", function () {
      const result = encodeSnarkjsG2Point(g2Input, "test_g2");
      expect(result.slice(32, 64)).to.deep.equal(bytes32(10n));
    });

    it("bytes[64..96] = y.c1_BE = bigintToBytes32BE(40n)", function () {
      const result = encodeSnarkjsG2Point(g2Input, "test_g2");
      expect(result.slice(64, 96)).to.deep.equal(bytes32(40n));
    });

    it("bytes[96..128] = y.c0_BE = bigintToBytes32BE(30n)", function () {
      const result = encodeSnarkjsG2Point(g2Input, "test_g2");
      expect(result.slice(96, 128)).to.deep.equal(bytes32(30n));
    });

    it("uses gamma input for vkGammeG2 (vk_gamma_2 → vkGammeG2)", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      expect(encoded.vkGammeG2).to.have.lengthOf(128);
      // gamma_2 = [["50","60"],["70","80"],["1","0"]]
      // vkGammeG2[0..32] = c1_BE of x = bytes32(60n)
      expect(encoded.vkGammeG2.slice(0, 32)).to.deep.equal(bytes32(60n));
    });

    it("vkDeltaG2 is 128 bytes", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      expect(encoded.vkDeltaG2).to.have.lengthOf(128);
    });
  });

  // ── Whole VK encoding ─────────────────────────────────────────────────────

  describe("encodeSnarkjsGroth16VerificationKey", function () {
    it("returns nrPubinputs = 4 for 3 public inputs", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      expect(encoded.nrPubinputs).to.equal(4);
    });

    it("vkAlphaG1 has length 64", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      expect(encoded.vkAlphaG1).to.have.lengthOf(64);
    });

    it("vkBetaG2 has length 128", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      expect(encoded.vkBetaG2).to.have.lengthOf(128);
    });

    it("vkGammeG2 has length 128", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      expect(encoded.vkGammeG2).to.have.lengthOf(128);
    });

    it("vkDeltaG2 has length 128", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      expect(encoded.vkDeltaG2).to.have.lengthOf(128);
    });

    it("vkIc has length 4", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      expect(encoded.vkIc).to.have.lengthOf(4);
    });

    it("each vkIc[i] has length 64", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      for (let i = 0; i < encoded.vkIc.length; i++) {
        expect(encoded.vkIc[i], `vkIc[${i}]`).to.have.lengthOf(64);
      }
    });

    it('vkIc[0] corresponds to IC[0] = ["1000","1001","1"] — x=1000, y=1001', function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      expect(encoded.vkIc[0].slice(0, 32)).to.deep.equal(bytes32(1000n));
      expect(encoded.vkIc[0].slice(32, 64)).to.deep.equal(bytes32(1001n));
    });

    it('vkIc[3] corresponds to IC[3] = ["1006","1007","1"] — x=1006, y=1007', function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      expect(encoded.vkIc[3].slice(0, 32)).to.deep.equal(bytes32(1006n));
      expect(encoded.vkIc[3].slice(32, 64)).to.deep.equal(bytes32(1007n));
    });

    it("vkAlphaG1 matches encodeSnarkjsG1Point(vk_alpha_1)", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      const direct = encodeSnarkjsG1Point(["1", "2", "1"], "alpha");
      expect(encoded.vkAlphaG1).to.deep.equal(direct);
    });

    it("vkBetaG2 matches encodeSnarkjsG2Point(vk_beta_2)", function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      const direct = encodeSnarkjsG2Point(
        [
          ["10", "20"],
          ["30", "40"],
          ["1", "0"],
        ],
        "beta"
      );
      expect(encoded.vkBetaG2).to.deep.equal(direct);
    });
  });

  // ── Rejection tests ───────────────────────────────────────────────────────

  describe("rejection: invalid protocol", function () {
    it('throws when protocol !== "groth16"', function () {
      expect(() =>
        encodeSnarkjsGroth16VerificationKey(
          syntheticVk({ protocol: "plonk" as "groth16" })
        )
      ).to.throw(/protocol/);
    });
  });

  describe("rejection: invalid curve", function () {
    it('throws when curve !== "bn128"', function () {
      expect(() =>
        encodeSnarkjsGroth16VerificationKey(
          syntheticVk({ curve: "bls12_381" as "bn128" })
        )
      ).to.throw(/curve/);
    });
  });

  describe("rejection: wrong nPublic", function () {
    it("throws when nPublic !== 3", function () {
      expect(() =>
        encodeSnarkjsGroth16VerificationKey(syntheticVk({ nPublic: 2 }))
      ).to.throw(/nPublic/);
    });

    it("throws when nPublic is 4", function () {
      expect(() =>
        encodeSnarkjsGroth16VerificationKey(syntheticVk({ nPublic: 4 }))
      ).to.throw(/nPublic/);
    });
  });

  describe("rejection: wrong IC length", function () {
    it("throws when IC has 3 entries instead of 4", function () {
      expect(() =>
        encodeSnarkjsGroth16VerificationKey(
          syntheticVk({
            IC: [
              ["1", "2", "1"],
              ["3", "4", "1"],
              ["5", "6", "1"],
            ],
          })
        )
      ).to.throw(/IC/);
    });

    it("throws when IC has 5 entries instead of 4", function () {
      expect(() =>
        encodeSnarkjsGroth16VerificationKey(
          syntheticVk({
            IC: [
              ["1", "2", "1"],
              ["3", "4", "1"],
              ["5", "6", "1"],
              ["7", "8", "1"],
              ["9", "10", "1"],
            ],
          })
        )
      ).to.throw(/IC/);
    });
  });

  describe("rejection: invalid G1 z coordinate", function () {
    it('throws when G1 z !== "1"', function () {
      expect(() =>
        encodeSnarkjsGroth16VerificationKey(
          syntheticVk({ vk_alpha_1: ["1", "2", "2"] })
        )
      ).to.throw(/projective z/);
    });
  });

  describe('rejection: invalid G2 z coordinate (not ["1","0"])', function () {
    it('throws when G2 z !== ["1","0"]', function () {
      expect(() =>
        encodeSnarkjsGroth16VerificationKey(
          syntheticVk({
            vk_beta_2: [
              ["10", "20"],
              ["30", "40"],
              ["2", "0"],
            ],
          })
        )
      ).to.throw(/projective z/);
    });
  });

  describe("rejection: non-decimal coordinate", function () {
    it("throws on hex-prefixed coordinate", function () {
      expect(() => encodeSnarkjsG1Point(["0x1", "2", "1"], "test")).to.throw();
    });

    it("throws on empty string coordinate", function () {
      expect(() => encodeSnarkjsG1Point(["", "2", "1"], "test")).to.throw();
    });

    it("throws on float-format coordinate", function () {
      expect(() => encodeSnarkjsG1Point(["1.5", "2", "1"], "test")).to.throw();
    });
  });

  describe("rejection: negative coordinate", function () {
    it("throws on negative coordinate string", function () {
      expect(() => encodeSnarkjsG1Point(["-1", "2", "1"], "test")).to.throw();
    });
  });

  describe("rejection: coordinate equal to BN254_FQ_MODULUS_DEC", function () {
    it("throws when coordinate equals BN254 Fq modulus", function () {
      expect(() =>
        encodeSnarkjsG1Point([BN254_FQ_MODULUS_DEC, "2", "1"], "test")
      ).to.throw(/Fq modulus/);
    });
  });

  // ── Loader tests ──────────────────────────────────────────────────────────

  describe("loadAndEncodeSnarkjsGroth16VerificationKey", function () {
    it("loads synthetic fixture and returns nrPubinputs 4", function () {
      const vk = loadAndEncodeSnarkjsGroth16VerificationKey(SYNTHETIC_VK_PATH);
      expect(vk.nrPubinputs).to.equal(4);
    });

    it("loads synthetic fixture vkIc length 4", function () {
      const vk = loadAndEncodeSnarkjsGroth16VerificationKey(SYNTHETIC_VK_PATH);
      expect(vk.vkIc).to.have.lengthOf(4);
    });

    it("throws on non-existent file", function () {
      expect(() =>
        loadAndEncodeSnarkjsGroth16VerificationKey(
          "tests/fixtures/zk/withdraw_sol_v1/does_not_exist.json"
        )
      ).to.throw(/cannot read/);
    });
  });

  // ── Rust preview tests ────────────────────────────────────────────────────

  describe("formatRustVkPreview", function () {
    it('output contains "Groth16Verifyingkey"', function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      const preview = formatRustVkPreview(encoded);
      expect(preview).to.include("Groth16Verifyingkey");
    });

    it('output contains "nr_pubinputs: 4"', function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      const preview = formatRustVkPreview(encoded);
      expect(preview).to.include("nr_pubinputs: 4");
    });

    it('output contains "vk_gamme_g2" — exact crate field typo', function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      const preview = formatRustVkPreview(encoded);
      expect(preview).to.include("vk_gamme_g2");
    });

    it('output does NOT contain "vk_gamma_g2" — must use crate typo spelling', function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      const preview = formatRustVkPreview(encoded);
      expect(preview).to.not.include("vk_gamma_g2");
    });

    it('output contains "vk_ic: &VK_IC"', function () {
      const encoded = encodeSnarkjsGroth16VerificationKey(syntheticVk());
      const preview = formatRustVkPreview(encoded);
      expect(preview).to.include("vk_ic: &VK_IC");
    });
  });
});
