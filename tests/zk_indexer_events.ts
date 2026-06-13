import { expect } from "chai";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import { IncrementalMerkleTree } from "../lib/zk_indexer/incremental_tree";
import {
  NormalizedNoteDepositedEvent,
  normalizeNoteDepositedEvent,
  sortEventsForReplay,
  replayNoteDeposits,
} from "../lib/zk_indexer/event_log";

// ── Test fixtures ────────────────────────────────────────────────────────────

// Two distinct valid BN254 Fr commitments (far below modulus, first byte 01/02).
const C0 = "0101010101010101010101010101010101010101010101010101010101010101";
const C1 = "0202020202020202020202020202020202020202020202020202020202020202";

// Minimal BN-like mock matching the Anchor BN API surface used in normalisation.
const bnLike = (s: string): { toString(): string } => ({ toString: () => s });

// Build a raw Anchor-event-shaped object using Buffer commitment and BN-like fields.
function baseRaw(
  commitmentHex: string,
  leafIndex: number
): Record<string, unknown> {
  return {
    commitment: Buffer.from(commitmentHex, "hex"),
    denomination: bnLike("100000000"),
    leafIndex: leafIndex, // Anchor camelCase form
    depositor: "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe",
    slot: bnLike("100"),
  };
}

// Build a fully-normalised event directly (for sort/replay tests).
function makeNormalized(
  commitmentHex: string,
  leafIndex: number,
  slot = 100n
): NormalizedNoteDepositedEvent {
  return {
    commitment_be_hex: commitmentHex,
    denomination: 100_000_000n,
    leaf_index: leafIndex,
    depositor: "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe",
    slot,
  };
}

// ── normalizeNoteDepositedEvent ──────────────────────────────────────────────

describe("normalizeNoteDepositedEvent", function () {
  this.timeout(5_000);

  it("normalizes Buffer commitment and BN-like denomination/leafIndex/slot", () => {
    const norm = normalizeNoteDepositedEvent(baseRaw(C0, 0));
    expect(norm.commitment_be_hex).to.equal(C0);
    expect(norm.denomination).to.equal(100_000_000n);
    expect(norm.leaf_index).to.equal(0);
    expect(norm.depositor).to.equal(
      "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe"
    );
    expect(norm.slot).to.equal(100n);
  });

  it("normalizes Uint8Array commitment", () => {
    const raw = {
      ...baseRaw(C0, 0),
      commitment: new Uint8Array(Buffer.from(C0, "hex")),
    };
    expect(normalizeNoteDepositedEvent(raw).commitment_be_hex).to.equal(C0);
  });

  it("normalizes number[] commitment", () => {
    const raw = {
      ...baseRaw(C0, 0),
      commitment: Array.from(Buffer.from(C0, "hex")),
    };
    expect(normalizeNoteDepositedEvent(raw).commitment_be_hex).to.equal(C0);
  });

  it("normalizes hex string commitment", () => {
    const raw = { ...baseRaw(C0, 0), commitment: C0 };
    expect(normalizeNoteDepositedEvent(raw).commitment_be_hex).to.equal(C0);
  });

  it("normalizes uppercase hex string commitment to lowercase", () => {
    const raw = { ...baseRaw(C0, 0), commitment: C0.toUpperCase() };
    expect(normalizeNoteDepositedEvent(raw).commitment_be_hex).to.equal(C0);
  });

  it("accepts both leafIndex (Anchor camelCase) and leaf_index (snake_case)", () => {
    // camelCase — standard Anchor event shape
    expect(normalizeNoteDepositedEvent(baseRaw(C0, 7)).leaf_index).to.equal(7);

    // snake_case — direct construction
    const rawSnake: Record<string, unknown> = {
      commitment: Buffer.from(C0, "hex"),
      denomination: 100_000_000n,
      leaf_index: 3,
      depositor: "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe",
      slot: 100n,
    };
    expect(normalizeNoteDepositedEvent(rawSnake).leaf_index).to.equal(3);
  });

  it("depositor: PublicKey-like object with toBase58() is accepted", () => {
    const raw = {
      ...baseRaw(C0, 0),
      depositor: {
        toBase58: () => "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe",
      },
    };
    expect(normalizeNoteDepositedEvent(raw).depositor).to.equal(
      "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe"
    );
  });

  it("rejects missing commitment", () => {
    const raw = { ...baseRaw(C0, 0), commitment: undefined };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw(
      "missing commitment"
    );
  });

  it("rejects commitment with wrong byte length", () => {
    const raw = { ...baseRaw(C0, 0), commitment: Buffer.alloc(31) };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw("wrong length");
  });

  it("rejects 0x-prefixed commitment string", () => {
    const raw = { ...baseRaw(C0, 0), commitment: "0x" + C0 };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw("0x prefix");
  });

  it("rejects negative leaf_index", () => {
    const raw = { ...baseRaw(C0, 0), leafIndex: -1 };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw("non-negative");
  });

  it("rejects non-safe integer leaf_index", () => {
    const raw = { ...baseRaw(C0, 0), leafIndex: Number.MAX_SAFE_INTEGER + 1 };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw("safe integer");
  });

  it("number[] commitment with out-of-range byte 256 rejects", () => {
    const bytes = Array.from(Buffer.from(C0, "hex"));
    bytes[0] = 256;
    const raw = { ...baseRaw(C0, 0), commitment: bytes };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw(
      "invalid commitment byte"
    );
  });

  it("number[] commitment with negative byte -1 rejects", () => {
    const bytes = Array.from(Buffer.from(C0, "hex"));
    bytes[5] = -1;
    const raw = { ...baseRaw(C0, 0), commitment: bytes };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw(
      "invalid commitment byte"
    );
  });

  it("number[] commitment with fractional byte rejects", () => {
    const bytes = Array.from(Buffer.from(C0, "hex"));
    bytes[10] = 1.5;
    const raw = { ...baseRaw(C0, 0), commitment: bytes };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw(
      "invalid commitment byte"
    );
  });

  it("invalid log_index: negative rejects", () => {
    const raw = { ...baseRaw(C0, 0), log_index: -1 };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw(
      "invalid log_index"
    );
  });

  it("invalid log_index: fractional rejects", () => {
    const raw = { ...baseRaw(C0, 0), log_index: 1.5 };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw(
      "invalid log_index"
    );
  });

  it("invalid log_index: unsafe integer rejects", () => {
    const raw = { ...baseRaw(C0, 0), log_index: Number.MAX_SAFE_INTEGER + 1 };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw(
      "invalid log_index"
    );
  });

  it("negative denomination rejects", () => {
    const raw = { ...baseRaw(C0, 0), denomination: -100_000_000n };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw(
      "denomination must be non-negative"
    );
  });

  it("negative slot rejects", () => {
    const raw = { ...baseRaw(C0, 0), slot: -1n };
    expect(() => normalizeNoteDepositedEvent(raw)).to.throw(
      "slot must be non-negative"
    );
  });
});

// ── sortEventsForReplay ──────────────────────────────────────────────────────

describe("sortEventsForReplay", function () {
  this.timeout(5_000);

  it("sorts by leaf_index ascending, then slot ascending, then log_index ascending (missing = 0)", () => {
    const events = [
      { ...makeNormalized(C0, 2, 100n), log_index: 0 }, // leaf 2
      { ...makeNormalized(C0, 0, 200n) }, //               leaf 0, slot 200, no log
      { ...makeNormalized(C1, 0, 100n), log_index: 1 }, // leaf 0, slot 100, log 1
      { ...makeNormalized(C1, 0, 100n) }, //               leaf 0, slot 100, no log → 0
    ];

    const sorted = sortEventsForReplay(events);

    // Primary: all leaf-0 entries precede the leaf-2 entry.
    expect(sorted[0].leaf_index).to.equal(0);
    expect(sorted[1].leaf_index).to.equal(0);
    expect(sorted[2].leaf_index).to.equal(0);
    expect(sorted[3].leaf_index).to.equal(2);

    // Secondary: among leaf-0 entries, slot 100 before slot 200.
    expect(sorted[0].slot).to.equal(100n);
    expect(sorted[1].slot).to.equal(100n);
    expect(sorted[2].slot).to.equal(200n);

    // Tertiary: among leaf-0/slot-100 entries, no log_index (→ 0) before log_index 1.
    expect(sorted[0].log_index).to.be.undefined;
    expect(sorted[1].log_index).to.equal(1);

    // Original array must not be mutated.
    expect(events[0].leaf_index).to.equal(2);
  });
});

// ── replayNoteDeposits ───────────────────────────────────────────────────────

describe("replayNoteDeposits", function () {
  this.timeout(30_000);

  before(async () => {
    await initPoseidon();
  });

  it("inserts two pre-sorted events: inserted=2, leaf_count=2, root_be_hex matches tree", () => {
    const tree = new IncrementalMerkleTree();
    // Caller is responsible for sorting before replay.
    const sorted = sortEventsForReplay([
      makeNormalized(C1, 1),
      makeNormalized(C0, 0),
    ]);

    const result = replayNoteDeposits(tree, sorted);

    expect(result.inserted).to.equal(2);
    expect(result.leaf_count).to.equal(2);
    expect(result.root_be_hex).to.equal(tree.getRoot());
    // Root must differ from the empty-tree root.
    expect(result.root_be_hex).to.not.equal(
      new IncrementalMerkleTree().getRoot()
    );
  });

  it("rejects gap: event with leaf_index=1 on empty tree throws expectedLeafIndex mismatch", () => {
    const tree = new IncrementalMerkleTree();
    // leaf_index=1 but tree is empty (leafCount=0 → expects index 0).
    expect(() => replayNoteDeposits(tree, [makeNormalized(C1, 1)])).to.throw(
      "expectedLeafIndex"
    );
  });

  it("rejects duplicate replay: re-replaying leaf_index=0 on a tree already at leaf_count=1 throws", () => {
    const tree = new IncrementalMerkleTree();
    replayNoteDeposits(tree, [makeNormalized(C0, 0)]); // advance to leaf_count=1
    // Replay same event: expectedLeafIndex=0 but tree.leafCount=1.
    expect(() => replayNoteDeposits(tree, [makeNormalized(C0, 0)])).to.throw(
      "expectedLeafIndex"
    );
    // Tree must be unmodified.
    expect(tree.getLeafCount()).to.equal(1);
  });
});
