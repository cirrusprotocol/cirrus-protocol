import { expect } from "chai";
import {
  initPoseidon,
  poseidonHash,
  frBigIntToHex32,
  frBigIntToBuffer32,
  bufferToFrBigInt,
  hexToFrBigInt,
} from "../lib/zk_indexer/poseidon";
import {
  TAG_LEAF,
  TAG_NODE,
  TREE_DEPTH,
  EMPTY_SUBTREES,
} from "../lib/zk_indexer/constants";
import {
  IncrementalMerkleTree,
  MerkleProof,
} from "../lib/zk_indexer/incremental_tree";

describe("zk_indexer: Poseidon constants", function () {
  this.timeout(30_000);

  before(async () => {
    await initPoseidon();
  });

  it("empty[0] = Poseidon(TAG_LEAF=2, 0, 0) matches hardcoded constant", () => {
    const computed = frBigIntToHex32(poseidonHash([TAG_LEAF, 0n, 0n]));
    expect(computed).to.equal(EMPTY_SUBTREES[0]);
  });

  it("empty subtree chain: empty[i+1] = Poseidon(TAG_NODE=3, empty[i], empty[i]) for i = 0..19", () => {
    for (let i = 0; i < TREE_DEPTH; i++) {
      const prev = hexToFrBigInt(EMPTY_SUBTREES[i]);
      const computed = frBigIntToHex32(poseidonHash([TAG_NODE, prev, prev]));
      expect(computed, `empty[${i + 1}] mismatch`).to.equal(
        EMPTY_SUBTREES[i + 1]
      );
    }
  });

  it("empty[20] (empty tree root) matches hardcoded constant", () => {
    expect(EMPTY_SUBTREES).to.have.length(TREE_DEPTH + 1);
    expect(EMPTY_SUBTREES[TREE_DEPTH]).to.equal(
      "08309ccafe9e331e3fc326a38fd73b32814d59314dde4a71ed629bd5e9067a25"
    );
  });
});

describe("zk_indexer: conversion helpers", function () {
  this.timeout(5_000);

  it("hexToFrBigInt rejects 0x-prefixed input", () => {
    expect(() =>
      hexToFrBigInt(
        "0x1d4267ad68f74b8ab95b6f80c2de898227e7f33ad5d3634a644d0773d4ea85b8"
      )
    ).to.throw("0x prefix");
  });

  it("hexToFrBigInt rejects non-hex characters", () => {
    const bad =
      "zz4267ad68f74b8ab95b6f80c2de898227e7f33ad5d3634a644d0773d4ea85b8";
    expect(() => hexToFrBigInt(bad)).to.throw("non-hex");
  });

  it("frBigIntToHex32 rejects negative input", () => {
    expect(() => frBigIntToHex32(-1n)).to.throw("negative");
  });

  it("frBigIntToHex32 rejects values larger than 32 bytes", () => {
    // 2^256 requires 65 hex digits — exceeds 32-byte limit.
    const tooBig = 2n ** 256n;
    expect(() => frBigIntToHex32(tooBig)).to.throw("exceeds 32 bytes");
  });

  it("frBigIntToBuffer32 returns exactly 32 bytes for 1n", () => {
    const buf = frBigIntToBuffer32(1n);
    expect(buf).to.have.length(32);
    // 1n big-endian: last byte is 0x01, all others are 0x00.
    expect(buf[31]).to.equal(1);
    for (let i = 0; i < 31; i++) expect(buf[i]).to.equal(0);
  });

  it("bufferToFrBigInt reads big-endian correctly", () => {
    // A buffer with 0x01 in the last byte should equal 1n.
    const buf = Buffer.alloc(32, 0);
    buf[31] = 1;
    expect(bufferToFrBigInt(buf)).to.equal(1n);

    // A buffer with 0x01 in the first byte should equal 2^248.
    const buf2 = Buffer.alloc(32, 0);
    buf2[0] = 1;
    expect(bufferToFrBigInt(buf2)).to.equal(2n ** 248n);
  });
});

// ── IncrementalMerkleTree ────────────────────────────────────────────────────

// Three distinct valid BN254 Fr commitments used across tree tests.
// All are far below the modulus (first byte 01/02/03 << 0x30).
const C0 = "0101010101010101010101010101010101010101010101010101010101010101";
const C1 = "0202020202020202020202020202020202020202020202020202020202020202";
const C2 = "0303030303030303030303030303030303030303030303030303030303030303";

/**
 * Recompute the Merkle root from a proof the same way the circuit does.
 * If the proof is consistent, the result must equal proof.root_be_hex.
 */
function recomputeRootFromProof(proof: MerkleProof): string {
  let cur = hexToFrBigInt(proof.commitment_be_hex);
  for (let i = 0; i < proof.path_elements_be_hex.length; i++) {
    const sibling = hexToFrBigInt(proof.path_elements_be_hex[i]);
    if (proof.path_indices[i] === 0) {
      cur = poseidonHash([TAG_NODE, cur, sibling]);
    } else {
      cur = poseidonHash([TAG_NODE, sibling, cur]);
    }
  }
  return frBigIntToHex32(cur);
}

describe("zk_indexer: IncrementalMerkleTree", function () {
  this.timeout(60_000);

  before(async () => {
    await initPoseidon();
  });

  it("empty tree: getRoot() equals EMPTY_SUBTREES[20], leafCount is 0", () => {
    const tree = new IncrementalMerkleTree();
    expect(tree.getRoot()).to.equal(EMPTY_SUBTREES[20]);
    expect(tree.getLeafCount()).to.equal(0);
  });

  it("append one leaf: returns index 0, leafCount becomes 1, root changes", () => {
    const tree = new IncrementalMerkleTree();
    const idx = tree.append(C0);
    expect(idx).to.equal(0);
    expect(tree.getLeafCount()).to.equal(1);
    expect(tree.getRoot()).to.not.equal(EMPTY_SUBTREES[20]);
  });

  it("single-leaf proof: path_indices all 0, path_elements = EMPTY_SUBTREES[0..19], proof verifies", () => {
    const tree = new IncrementalMerkleTree();
    tree.append(C0);
    const proof = tree.getProofByLeafIndex(0);

    expect(proof.leaf_index).to.equal(0);
    expect(proof.commitment_be_hex).to.equal(C0);
    expect(proof.path_indices).to.deep.equal(new Array(TREE_DEPTH).fill(0));
    for (let i = 0; i < TREE_DEPTH; i++) {
      expect(proof.path_elements_be_hex[i], `level ${i}`).to.equal(
        EMPTY_SUBTREES[i]
      );
    }
    expect(recomputeRootFromProof(proof)).to.equal(tree.getRoot());
  });

  it("two-leaf tree: proof for index 0 has path_indices[0]=0, path_elements[0]=C1, proof verifies", () => {
    const tree = new IncrementalMerkleTree();
    tree.append(C0);
    tree.append(C1);
    const proof = tree.getProofByLeafIndex(0);

    expect(proof.path_indices[0]).to.equal(0);
    expect(proof.path_elements_be_hex[0]).to.equal(C1);
    expect(recomputeRootFromProof(proof)).to.equal(tree.getRoot());
  });

  it("two-leaf tree: proof for index 1 has path_indices[0]=1, path_elements[0]=C0, proof verifies", () => {
    const tree = new IncrementalMerkleTree();
    tree.append(C0);
    tree.append(C1);
    const proof = tree.getProofByLeafIndex(1);

    expect(proof.path_indices[0]).to.equal(1);
    expect(proof.path_elements_be_hex[0]).to.equal(C0);
    expect(recomputeRootFromProof(proof)).to.equal(tree.getRoot());
  });

  it("three-leaf tree: proof for index 2 has path_indices=[0,1,...], correct siblings, proof verifies", () => {
    const tree = new IncrementalMerkleTree();
    tree.append(C0);
    tree.append(C1);
    tree.append(C2);
    const proof = tree.getProofByLeafIndex(2);

    // leaf_index 2 = binary 10; LSB-first: bit[0]=0, bit[1]=1, rest=0.
    expect(proof.path_indices[0]).to.equal(0);
    expect(proof.path_indices[1]).to.equal(1);
    expect(proof.path_indices.slice(2)).to.deep.equal(
      new Array(TREE_DEPTH - 2).fill(0)
    );

    // Level 0 sibling: leaf at index 3 does not exist → empty[0].
    expect(proof.path_elements_be_hex[0]).to.equal(EMPTY_SUBTREES[0]);

    // Level 1 sibling: the left pair (C0, C1) → Poseidon(TAG_NODE, C0, C1).
    const expectedLevel1Sibling = frBigIntToHex32(
      poseidonHash([TAG_NODE, hexToFrBigInt(C0), hexToFrBigInt(C1)])
    );
    expect(proof.path_elements_be_hex[1]).to.equal(expectedLevel1Sibling);

    expect(recomputeRootFromProof(proof)).to.equal(tree.getRoot());
  });

  it("duplicate commitment: getProofByCommitment returns first occurrence (index 0), second accessible by leaf index", () => {
    const tree = new IncrementalMerkleTree();
    tree.append(C0); // index 0
    tree.append(C0); // index 1 — duplicate
    expect(tree.getLeafCount()).to.equal(2);

    const proof = tree.getProofByCommitment(C0);
    expect(proof.leaf_index).to.equal(0);

    // Second occurrence is still in the tree and provable by leaf index.
    const proof1 = tree.getProofByLeafIndex(1);
    expect(proof1.commitment_be_hex).to.equal(C0);
    expect(proof1.leaf_index).to.equal(1);

    // Both proofs verify against the same current root.
    expect(recomputeRootFromProof(proof)).to.equal(tree.getRoot());
    expect(recomputeRootFromProof(proof1)).to.equal(tree.getRoot());
  });

  it("getProofByCommitment throws 'commitment not found' for unknown commitment", () => {
    const tree = new IncrementalMerkleTree();
    tree.append(C0);
    expect(() => tree.getProofByCommitment(C1)).to.throw(
      "commitment not found"
    );
  });

  it("exportWitnessInputs throws 'commitment not found' for unknown commitment", () => {
    const tree = new IncrementalMerkleTree();
    tree.append(C0);
    expect(() => tree.exportWitnessInputs(C1)).to.throw("commitment not found");
  });

  it("exportWitnessInputs returns same result as getProofByCommitment for known commitment", () => {
    const tree = new IncrementalMerkleTree();
    tree.append(C0);
    tree.append(C1);
    expect(tree.exportWitnessInputs(C0)).to.deep.equal(
      tree.getProofByCommitment(C0)
    );
    // Verify shape.
    const w = tree.exportWitnessInputs(C1);
    expect(w).to.have.property("leaf_index", 1);
    expect(w.path_elements_be_hex).to.have.length(TREE_DEPTH);
    expect(w.path_indices).to.have.length(TREE_DEPTH);
    expect(recomputeRootFromProof(w)).to.equal(tree.getRoot());
  });

  it("expectedLeafIndex mismatch rejects", () => {
    const tree = new IncrementalMerkleTree();
    tree.append(C0); // occupies index 0
    expect(() => tree.append(C1, 5)).to.throw("expectedLeafIndex");
    // Tree must be unmodified after rejected append.
    expect(tree.getLeafCount()).to.equal(1);
  });

  it("malformed commitment rejects on append", () => {
    const tree = new IncrementalMerkleTree();
    expect(() => tree.append("not_valid_hex")).to.throw();
    expect(() => tree.append("0x" + C0)).to.throw("0x prefix");
    expect(tree.getLeafCount()).to.equal(0);
  });

  it("getProofByLeafIndex rejects negative and out-of-range indices", () => {
    const tree = new IncrementalMerkleTree();
    tree.append(C0); // only index 0 exists
    expect(() => tree.getProofByLeafIndex(-1)).to.throw();
    expect(() => tree.getProofByLeafIndex(1)).to.throw();
    expect(() => tree.getProofByLeafIndex(100)).to.throw();
  });
});
