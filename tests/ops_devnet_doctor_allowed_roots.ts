import { expect } from "chai";
import * as fs from "fs";
import {
  analyzeAllowedRootsState,
  AllowedRootsAnalysis,
  MAX_ROOTS,
} from "../scripts/ops/devnet_doctor";

// Two distinct base58 pubkeys used as fixtures throughout.
const ADMIN = "So11111111111111111111111111111111111111112";
const ROOT_SUBMITTER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATTESTER = ROOT_SUBMITTER;
const NEAR = MAX_ROOTS - 2; // 8

function base(
  overrides: Partial<Parameters<typeof analyzeAllowedRootsState>[0]> = {}
): AllowedRootsAnalysis {
  return analyzeAllowedRootsState({
    allowedRootsCount: 2,
    maxRoots: MAX_ROOTS,
    nearCapacityThreshold: NEAR,
    adminAuthorityStr: ADMIN,
    rootSubmitterAuthorityStr: ROOT_SUBMITTER,
    attesterPubkeyStr: ATTESTER,
    verifierPubkeyStrs: [ATTESTER],
    ...overrides,
  });
}

describe("analyzeAllowedRootsState", () => {
  describe("capacity", () => {
    it("low root count reports correct capacityRemaining", () => {
      const r = base({ allowedRootsCount: 2 });
      expect(r.capacityRemaining).to.equal(8);
      expect(r.isFull).to.be.false;
      expect(r.isNearCapacity).to.be.false;
    });

    it("near-capacity threshold fires isNearCapacity and not isFull", () => {
      const r = base({ allowedRootsCount: NEAR });
      expect(r.isNearCapacity).to.be.true;
      expect(r.isFull).to.be.false;
      expect(r.capacityRemaining).to.equal(MAX_ROOTS - NEAR);
    });

    it("one below threshold does not fire isNearCapacity", () => {
      const r = base({ allowedRootsCount: NEAR - 1 });
      expect(r.isNearCapacity).to.be.false;
      expect(r.isFull).to.be.false;
    });

    it("full roots fires isFull and not isNearCapacity", () => {
      const r = base({ allowedRootsCount: MAX_ROOTS });
      expect(r.isFull).to.be.true;
      expect(r.isNearCapacity).to.be.false;
      expect(r.capacityRemaining).to.equal(0);
    });

    it("returns correct maxRoots and nearCapacityThreshold fields", () => {
      const r = base({ allowedRootsCount: 3 });
      expect(r.maxRoots).to.equal(MAX_ROOTS);
      expect(r.nearCapacityThreshold).to.equal(NEAR);
    });
  });

  describe("admin equals root submitter", () => {
    it("fires adminEqualsRootSubmitter when keys match", () => {
      const r = base({ rootSubmitterAuthorityStr: ADMIN });
      expect(r.adminEqualsRootSubmitter).to.be.true;
    });

    it("does not fire when keys differ", () => {
      const r = base({ rootSubmitterAuthorityStr: ROOT_SUBMITTER });
      expect(r.adminEqualsRootSubmitter).to.be.false;
    });

    it("null rootSubmitterAuthorityStr disables the check", () => {
      const r = base({ rootSubmitterAuthorityStr: null });
      expect(r.adminEqualsRootSubmitter).to.be.false;
    });
  });

  describe("attester in verifier set", () => {
    it("returns true when attester is in verifier set", () => {
      const r = base({
        attesterPubkeyStr: ATTESTER,
        verifierPubkeyStrs: [ATTESTER, ADMIN],
      });
      expect(r.attesterInVerifierSet).to.be.true;
    });

    it("returns false when attester is not in verifier set", () => {
      const r = base({
        attesterPubkeyStr: ADMIN,
        verifierPubkeyStrs: [ATTESTER],
      });
      expect(r.attesterInVerifierSet).to.be.false;
    });

    it("returns false for empty verifier set", () => {
      const r = base({ verifierPubkeyStrs: [] });
      expect(r.attesterInVerifierSet).to.be.false;
    });

    it("null attesterPubkeyStr yields null attesterInVerifierSet", () => {
      const r = base({ attesterPubkeyStr: null });
      expect(r.attesterInVerifierSet).to.be.null;
    });
  });
});

describe("devnet_doctor.ts static scan — read-only safety", () => {
  const src = fs.readFileSync("scripts/ops/devnet_doctor.ts", "utf8");

  it("does not call sendRawTransaction", () => {
    expect(src).to.not.include("sendRawTransaction");
  });

  it("does not call sendTransaction", () => {
    expect(src).to.not.include("sendTransaction");
  });

  it("does not call .rpc()", () => {
    expect(src).to.not.include(".rpc(");
  });

  it("does not import or instantiate Keypair", () => {
    expect(src).to.not.include("Keypair");
  });

  it("does not handle a --send flag", () => {
    expect(src).to.not.include('"--send"');
  });
});
