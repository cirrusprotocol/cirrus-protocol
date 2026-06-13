// In-memory incremental Merkle tree for depth-20 BN254 note commitments.
//
// Prerequisites: call initPoseidon() from poseidon.ts before any append/proof call.
//
// Path convention (matches Phase 2 ShieldedWithdraw circuit):
//   path_indices[i] = (leaf_index >> i) & 1
//   0 = current node is LEFT child, sibling is RIGHT
//   1 = current node is RIGHT child, sibling is LEFT
//
// All hex values: 64-char lowercase, 32-byte big-endian, no 0x prefix.

import { poseidonHash, hexToFrBigInt, frBigIntToHex32 } from "./poseidon";
import { TAG_NODE, TREE_DEPTH, EMPTY_SUBTREES } from "./constants";

export interface MerkleProof {
  leaf_index: number;
  root_be_hex: string;
  commitment_be_hex: string;
  path_elements_be_hex: string[]; // length = depth, level 0 = leaf level
  path_indices: number[]; // length = depth, 0 = left child, 1 = right child
}

export class IncrementalMerkleTree {
  readonly depth: number;
  // Leaves stored as 64-char lowercase hex, one per inserted commitment.
  private readonly leaves: string[];
  private _root: string;
  // Maps normalized commitment hex → all leaf indices (insertion order).
  private readonly commitmentToLeafIndices: Map<string, number[]>;

  constructor(depth: number = TREE_DEPTH) {
    if (depth < 1 || depth > 30)
      throw new Error("IncrementalMerkleTree: depth must be in [1, 30]");
    if (!EMPTY_SUBTREES[depth])
      throw new Error(
        `IncrementalMerkleTree: EMPTY_SUBTREES has no entry for depth ${depth}`
      );
    this.depth = depth;
    this.leaves = [];
    this._root = EMPTY_SUBTREES[depth];
    this.commitmentToLeafIndices = new Map();
  }

  getLeafCount(): number {
    return this.leaves.length;
  }

  getRoot(): string {
    return this._root;
  }

  /**
   * Insert a commitment as the next leaf.
   *
   * @param commitmentHex  64-char lowercase hex, no 0x prefix.
   * @param expectedLeafIndex  If provided, must equal current leafCount. Use this
   *   to detect gaps: if event.leaf_index != tree.getLeafCount(), pass it here and
   *   let append() throw rather than silently inserting at the wrong position.
   * @returns The leaf index assigned to this commitment.
   */
  append(commitmentHex: string, expectedLeafIndex?: number): number {
    // Validate and normalize to lowercase 64-char hex. hexToFrBigInt throws on
    // 0x prefix, non-hex chars, or wrong length.
    const normalized = frBigIntToHex32(hexToFrBigInt(commitmentHex));

    const leafIndex = this.leaves.length;

    if (expectedLeafIndex !== undefined && expectedLeafIndex !== leafIndex) {
      throw new Error(
        `append: expectedLeafIndex=${expectedLeafIndex} but tree leafCount=${leafIndex}`
      );
    }

    const capacity = 1 << this.depth;
    if (leafIndex >= capacity) {
      throw new Error(`append: tree is full (capacity=${capacity})`);
    }

    this.leaves.push(normalized);

    const existing = this.commitmentToLeafIndices.get(normalized);
    if (existing) {
      existing.push(leafIndex);
    } else {
      this.commitmentToLeafIndices.set(normalized, [leafIndex]);
    }

    // Recompute root from full leaf array. O(N*depth) but correct.
    this._root = this.computeSubtreeHash(0, this.depth);
    return leafIndex;
  }

  /**
   * Compute the hash of the subtree whose leaves span
   * [startLeafIdx, startLeafIdx + 2^level - 1].
   *
   * If the entire range is beyond the populated leaves, return the cached
   * empty subtree constant (no Poseidon calls needed).
   */
  private computeSubtreeHash(startLeafIdx: number, level: number): string {
    if (startLeafIdx >= this.leaves.length) {
      return EMPTY_SUBTREES[level];
    }
    if (level === 0) {
      return this.leaves[startLeafIdx];
    }
    const half = 1 << (level - 1);
    const left = this.computeSubtreeHash(startLeafIdx, level - 1);
    const right = this.computeSubtreeHash(startLeafIdx + half, level - 1);
    return frBigIntToHex32(
      poseidonHash([TAG_NODE, hexToFrBigInt(left), hexToFrBigInt(right)])
    );
  }

  getProofByLeafIndex(index: number): MerkleProof {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(
        `getProofByLeafIndex: index ${index} out of range, leafCount=${this.leaves.length}`
      );
    }

    const pathElements: string[] = [];
    const pathIndices: number[] = [];

    for (let i = 0; i < this.depth; i++) {
      const bit = (index >> i) & 1;
      pathIndices.push(bit);
      // Sibling's subtree starts at the leaf index of the node adjacent
      // to the current node at this level.
      const siblingStart = ((index >> i) ^ 1) << i;
      pathElements.push(this.computeSubtreeHash(siblingStart, i));
    }

    return {
      leaf_index: index,
      root_be_hex: this._root,
      commitment_be_hex: this.leaves[index],
      path_elements_be_hex: pathElements,
      path_indices: pathIndices,
    };
  }

  /**
   * Return a proof for the first insertion of this commitment.
   * Throws if the commitment has never been appended — callers must not pass
   * an unknown commitment into witness construction.
   * If the same commitment was appended more than once, the proof for the
   * earliest leaf_index is returned; all occurrences remain accessible via
   * getProofByLeafIndex.
   */
  getProofByCommitment(commitmentHex: string): MerkleProof {
    const normalized = frBigIntToHex32(hexToFrBigInt(commitmentHex));
    const indices = this.commitmentToLeafIndices.get(normalized);
    if (!indices || indices.length === 0)
      throw new Error(`getProofByCommitment: commitment not found in tree`);
    return this.getProofByLeafIndex(indices[0]);
  }

  /**
   * Return proof shaped for direct use as circuit witness inputs.
   * Delegates to getProofByCommitment; throws if commitment is not in the tree.
   */
  exportWitnessInputs(commitmentHex: string): MerkleProof {
    return this.getProofByCommitment(commitmentHex);
  }
}
