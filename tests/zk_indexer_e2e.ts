import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  initPoseidon,
  poseidonHash,
  hexToFrBigInt,
  frBigIntToHex32,
} from "../lib/zk_indexer/poseidon";
import {
  IncrementalMerkleTree,
  MerkleProof,
} from "../lib/zk_indexer/incremental_tree";
import {
  NormalizedNoteDepositedEvent,
  sortEventsForReplay,
  replayNoteDeposits,
} from "../lib/zk_indexer/event_log";
import {
  buildSnapshot,
  saveSnapshot,
  loadSnapshot,
  serializeEvent,
} from "../lib/zk_indexer/persistence";
import {
  TREE_DEPTH,
  EMPTY_SUBTREES,
  TAG_NODE,
} from "../lib/zk_indexer/constants";
import { extractNoteDepositedEventsFromFixtures } from "../lib/zk_indexer/log_parser";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEPOSITOR = "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe";
const C0 = "0101010101010101010101010101010101010101010101010101010101010101";
const C1 = "0202020202020202020202020202020202020202020202020202020202020202";
const C2 = "0303030303030303030303030303030303030303030303030303030303030303";

function eventJsonLog(name: string, data: Record<string, unknown>): string {
  return `Program log: EVENT_JSON:${JSON.stringify({ name, data })}`;
}

function noteData(
  commitmentHex: string,
  leafIndex: number,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    commitment: commitmentHex,
    denomination: "100000000",
    leafIndex,
    depositor: DEPOSITOR,
    slot: "100",
    ...extras,
  };
}

function tmpPath(): string {
  return path.join(
    os.tmpdir(),
    `zk_e2e_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
  );
}

// Walk up the proof path using TAG_NODE domain separation, matching the tree's
// computeSubtreeHash convention: left child is cur, right is sibling when
// path_indices[i] === 0, and vice versa when path_indices[i] === 1.
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("zk_indexer: end-to-end pipeline", function () {
  this.timeout(60_000);

  before(async () => {
    await initPoseidon();
  });

  it("1. full local EVENT_JSON pipeline: extract → sort → replay → snapshot → load → proof", () => {
    // Fixtures use logs only. Unrelated lines appear before and between events.
    // Intentionally out of order: fixture A has C1@leaf1, B has C0@leaf0, C has C2@leaf2.
    const fixtures = [
      {
        logs: [
          "Program log: Instruction: DepositNote",
          eventJsonLog("noteDeposited", noteData(C1, 1)),
          "Program log: Program shielded_pool_anchor success",
        ],
      },
      {
        logs: [
          "Program log: unrelated",
          eventJsonLog("noteDeposited", noteData(C0, 0)),
        ],
      },
      {
        logs: [
          "Program log: unrelated before",
          eventJsonLog("noteDeposited", noteData(C2, 2)),
          "Program log: unrelated after",
        ],
      },
    ];

    // Extraction preserves fixture/log input order: [1, 0, 2]
    const extracted = extractNoteDepositedEventsFromFixtures(fixtures);
    expect(extracted).to.have.length(3);
    expect(extracted[0].leaf_index).to.equal(1);
    expect(extracted[1].leaf_index).to.equal(0);
    expect(extracted[2].leaf_index).to.equal(2);

    // Sort corrects to replay order: [0, 1, 2]
    const sorted = sortEventsForReplay(extracted);
    expect(sorted[0].leaf_index).to.equal(0);
    expect(sorted[1].leaf_index).to.equal(1);
    expect(sorted[2].leaf_index).to.equal(2);

    // Replay into fresh tree
    const tree = new IncrementalMerkleTree();
    const replayResult = replayNoteDeposits(tree, sorted);
    expect(replayResult.inserted).to.equal(3);
    expect(replayResult.leaf_count).to.equal(3);
    expect(replayResult.root_be_hex).to.not.equal(EMPTY_SUBTREES[TREE_DEPTH]);

    // Build snapshot — root and leaf_count must match the replay result
    const snapshot = buildSnapshot(sorted);
    expect(snapshot.leaf_count).to.equal(replayResult.leaf_count);
    expect(snapshot.last_root_be_hex).to.equal(tree.getRoot());

    // Save and load round-trip
    const p = tmpPath();
    try {
      saveSnapshot(p, sorted);
      const loaded = loadSnapshot(p);

      expect(loaded.snapshot.last_root_be_hex).to.equal(
        snapshot.last_root_be_hex
      );
      expect(loaded.tree.getRoot()).to.equal(snapshot.last_root_be_hex);
      expect(loaded.tree.getLeafCount()).to.equal(3);

      // Proof for C1 (leaf_index 1)
      const proof = loaded.tree.getProofByCommitment(C1);
      expect(proof.leaf_index).to.equal(1);
      expect(proof.root_be_hex).to.equal(snapshot.last_root_be_hex);
      expect(proof.path_elements_be_hex).to.have.length(TREE_DEPTH);
      expect(proof.path_indices).to.have.length(TREE_DEPTH);

      // Recomputed root from proof path must equal the snapshot root
      expect(recomputeRootFromProof(proof)).to.equal(snapshot.last_root_be_hex);
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("2. no-sort replay rejects unsorted events with expectedLeafIndex error", () => {
    // leaf 1 first, leaf 0 second — wrong order
    const fixtures = [
      { logs: [eventJsonLog("noteDeposited", noteData(C1, 1))] },
      { logs: [eventJsonLog("noteDeposited", noteData(C0, 0))] },
    ];
    const unsorted = extractNoteDepositedEventsFromFixtures(fixtures);
    expect(unsorted[0].leaf_index).to.equal(1);
    expect(unsorted[1].leaf_index).to.equal(0);

    const tree = new IncrementalMerkleTree();
    // First append tries expectedLeafIndex=1 on an empty tree (leafCount=0)
    expect(() => replayNoteDeposits(tree, unsorted)).to.throw(
      "expectedLeafIndex"
    );
    // Tree is unmodified: the failed append did not persist any leaf
    expect(tree.getLeafCount()).to.equal(0);
  });

  it("3. snapshot round-trip: exportWitnessInputs equals getProofByCommitment, root recomputes correctly", () => {
    const fixtures = [
      { logs: [eventJsonLog("noteDeposited", noteData(C0, 0))] },
      { logs: [eventJsonLog("noteDeposited", noteData(C1, 1))] },
    ];
    const sorted = sortEventsForReplay(
      extractNoteDepositedEventsFromFixtures(fixtures)
    );

    const p = tmpPath();
    try {
      saveSnapshot(p, sorted);
      const loaded = loadSnapshot(p);

      const witnessInputs = loaded.tree.exportWitnessInputs(C0);
      const proofByCommitment = loaded.tree.getProofByCommitment(C0);

      // exportWitnessInputs delegates to getProofByCommitment — same result
      expect(witnessInputs).to.deep.equal(proofByCommitment);

      // Root recomputed from witness inputs must equal the loaded snapshot root
      expect(recomputeRootFromProof(witnessInputs)).to.equal(
        loaded.snapshot.last_root_be_hex
      );
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("4. tampered snapshot root is rejected", () => {
    const fixtures = [
      { logs: [eventJsonLog("noteDeposited", noteData(C0, 0))] },
    ];
    const sorted = sortEventsForReplay(
      extractNoteDepositedEventsFromFixtures(fixtures)
    );

    const p = tmpPath();
    try {
      saveSnapshot(p, sorted);
      const tampered = JSON.parse(fs.readFileSync(p, "utf-8"));
      // Replace root with empty-tree root — guaranteed to differ for a non-empty snapshot
      tampered.last_root_be_hex = EMPTY_SUBTREES[TREE_DEPTH];
      fs.writeFileSync(p, JSON.stringify(tampered), "utf-8");

      expect(() => loadSnapshot(p)).to.throw("root mismatch");
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("5. tampered event order is rejected with expectedLeafIndex error", () => {
    const p = tmpPath();
    try {
      // Write a snapshot with events in wrong order: leaf 1 before leaf 0
      const ev0: NormalizedNoteDepositedEvent = {
        commitment_be_hex: C0,
        denomination: 100_000_000n,
        leaf_index: 0,
        depositor: DEPOSITOR,
        slot: 100n,
      };
      const ev1: NormalizedNoteDepositedEvent = {
        commitment_be_hex: C1,
        denomination: 100_000_000n,
        leaf_index: 1,
        depositor: DEPOSITOR,
        slot: 100n,
      };
      const bad = {
        version: 1,
        tree_depth: TREE_DEPTH,
        events: [serializeEvent(ev1), serializeEvent(ev0)], // leaf 1 first
        last_root_be_hex: EMPTY_SUBTREES[TREE_DEPTH],
        leaf_count: 2,
      };
      fs.writeFileSync(p, JSON.stringify(bad), "utf-8");

      // Replay during loadSnapshot hits expectedLeafIndex=1 on empty tree
      expect(() => loadSnapshot(p)).to.throw("expectedLeafIndex");
    } finally {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });
});
