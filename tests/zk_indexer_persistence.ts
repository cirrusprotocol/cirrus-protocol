import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import { IncrementalMerkleTree } from "../lib/zk_indexer/incremental_tree";
import {
  NormalizedNoteDepositedEvent,
  replayNoteDeposits,
} from "../lib/zk_indexer/event_log";
import {
  PersistedNoteDepositedEvent,
  PersistedIndexerSnapshot,
  SnapshotFetchMeta,
  serializeEvent,
  deserializeEvent,
  buildSnapshot,
  saveSnapshot,
  loadSnapshot,
} from "../lib/zk_indexer/persistence";
import { TREE_DEPTH, EMPTY_SUBTREES } from "../lib/zk_indexer/constants";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DEPOSITOR = "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe";
const C0 = "0101010101010101010101010101010101010101010101010101010101010101";
const C1 = "0202020202020202020202020202020202020202020202020202020202020202";

function makeEvent(
  commitmentHex: string,
  leafIndex: number,
  slot = 100n
): NormalizedNoteDepositedEvent {
  return {
    commitment_be_hex: commitmentHex,
    denomination: 100_000_000n,
    leaf_index: leafIndex,
    depositor: DEPOSITOR,
    slot,
  };
}

function tmpPath(): string {
  return path.join(
    os.tmpdir(),
    `zk_idx_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("zk_indexer: persistence", function () {
  this.timeout(60_000);

  before(async () => {
    await initPoseidon();
  });

  // ── serializeEvent ──────────────────────────────────────────────────────────

  it("serializeEvent converts bigint denomination and slot to decimal strings", () => {
    const event = makeEvent(C0, 0);
    const persisted = serializeEvent(event);
    expect(typeof persisted.denomination).to.equal("string");
    expect(persisted.denomination).to.equal("100000000");
    expect(typeof persisted.slot).to.equal("string");
    expect(persisted.slot).to.equal("100");
    expect(persisted.commitment_be_hex).to.equal(C0);
    expect(persisted.leaf_index).to.equal(0);
    expect(persisted.depositor).to.equal(DEPOSITOR);
  });

  it("serializeEvent includes optional fields when present", () => {
    const event: NormalizedNoteDepositedEvent = {
      ...makeEvent(C0, 0),
      signature: "5xyz",
      log_index: 3,
    };
    const persisted = serializeEvent(event);
    expect(persisted.signature).to.equal("5xyz");
    expect(persisted.log_index).to.equal(3);
  });

  it("serializeEvent omits optional fields when absent", () => {
    const persisted = serializeEvent(makeEvent(C0, 0));
    expect(persisted).to.not.have.property("signature");
    expect(persisted).to.not.have.property("log_index");
  });

  // ── deserializeEvent ────────────────────────────────────────────────────────

  it("deserializeEvent restores bigint denomination and slot", () => {
    const persisted: PersistedNoteDepositedEvent = {
      commitment_be_hex: C0,
      denomination: "100000000",
      leaf_index: 0,
      depositor: DEPOSITOR,
      slot: "999",
    };
    const event = deserializeEvent(persisted);
    expect(typeof event.denomination).to.equal("bigint");
    expect(event.denomination).to.equal(100_000_000n);
    expect(typeof event.slot).to.equal("bigint");
    expect(event.slot).to.equal(999n);
  });

  it("deserializeEvent preserves optional fields", () => {
    const persisted: PersistedNoteDepositedEvent = {
      commitment_be_hex: C0,
      denomination: "1",
      leaf_index: 0,
      depositor: DEPOSITOR,
      slot: "1",
      signature: "sig123",
      log_index: 7,
    };
    const event = deserializeEvent(persisted);
    expect(event.signature).to.equal("sig123");
    expect(event.log_index).to.equal(7);
  });

  it("deserializeEvent rejects non-numeric denomination string", () => {
    const persisted: PersistedNoteDepositedEvent = {
      commitment_be_hex: C0,
      denomination: "not_a_number",
      leaf_index: 0,
      depositor: DEPOSITOR,
      slot: "100",
    };
    // Delegation to normalizeNoteDepositedEvent means BigInt("not_a_number")
    // throws a SyntaxError; just verify it throws at all.
    expect(() => deserializeEvent(persisted)).to.throw();
  });

  // ── buildSnapshot ───────────────────────────────────────────────────────────

  it("buildSnapshot for two events: version=1, tree_depth=TREE_DEPTH, leaf_count=2, root matches independent replay", () => {
    const events = [makeEvent(C0, 0), makeEvent(C1, 1)];
    const snapshot = buildSnapshot(events);

    expect(snapshot.version).to.equal(1);
    expect(snapshot.tree_depth).to.equal(TREE_DEPTH);
    expect(snapshot.leaf_count).to.equal(2);
    expect(snapshot.events).to.have.length(2);
    expect(snapshot.events[0].denomination).to.equal("100000000");

    const tree = new IncrementalMerkleTree();
    const result = replayNoteDeposits(tree, events);
    expect(snapshot.last_root_be_hex).to.equal(result.root_be_hex);
    expect(snapshot.last_root_be_hex).to.not.equal(EMPTY_SUBTREES[TREE_DEPTH]);
  });

  it("buildSnapshot for empty events: leaf_count=0, root equals empty tree root", () => {
    const snapshot = buildSnapshot([]);
    expect(snapshot.leaf_count).to.equal(0);
    expect(snapshot.last_root_be_hex).to.equal(EMPTY_SUBTREES[TREE_DEPTH]);
    expect(snapshot.events).to.have.length(0);
  });

  // ── saveSnapshot ────────────────────────────────────────────────────────────

  it("saveSnapshot writes valid JSON with bigint fields serialized as strings", () => {
    const p = tmpPath();
    saveSnapshot(p, [makeEvent(C0, 0)]);

    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as PersistedIndexerSnapshot;
    expect(parsed.version).to.equal(1);
    expect(parsed.tree_depth).to.equal(TREE_DEPTH);
    expect(parsed.leaf_count).to.equal(1);
    expect(parsed.events).to.have.length(1);
    expect(parsed.events[0].denomination).to.equal("100000000");
    expect(typeof parsed.events[0].denomination).to.equal("string");

    fs.unlinkSync(p);
  });

  // ── loadSnapshot ────────────────────────────────────────────────────────────

  it("loadSnapshot rebuilds tree: root, leaf_count, and events match saved snapshot", () => {
    const p = tmpPath();
    const events = [makeEvent(C0, 0), makeEvent(C1, 1)];
    saveSnapshot(p, events);

    const { snapshot, events: loaded, tree } = loadSnapshot(p);

    expect(snapshot.leaf_count).to.equal(2);
    expect(loaded).to.have.length(2);
    expect(loaded[0].commitment_be_hex).to.equal(C0);
    expect(loaded[1].commitment_be_hex).to.equal(C1);
    expect(loaded[0].denomination).to.equal(100_000_000n);
    expect(tree.getLeafCount()).to.equal(2);
    expect(tree.getRoot()).to.equal(snapshot.last_root_be_hex);

    fs.unlinkSync(p);
  });

  it("loadSnapshot rejects unsupported version (version: 3)", () => {
    const p = tmpPath();
    const bad: PersistedIndexerSnapshot = {
      version: 3,
      tree_depth: TREE_DEPTH,
      events: [],
      last_root_be_hex: EMPTY_SUBTREES[TREE_DEPTH],
      leaf_count: 0,
    };
    fs.writeFileSync(p, JSON.stringify(bad), "utf-8");
    expect(() => loadSnapshot(p)).to.throw("version");
    fs.unlinkSync(p);
  });

  it("loadSnapshot rejects tree_depth mismatch", () => {
    const p = tmpPath();
    const bad: PersistedIndexerSnapshot = {
      version: 1,
      tree_depth: 10,
      events: [],
      last_root_be_hex: EMPTY_SUBTREES[TREE_DEPTH],
      leaf_count: 0,
    };
    fs.writeFileSync(p, JSON.stringify(bad), "utf-8");
    expect(() => loadSnapshot(p)).to.throw("tree_depth");
    fs.unlinkSync(p);
  });

  it("loadSnapshot rejects root mismatch (tampered last_root_be_hex)", () => {
    const p = tmpPath();
    saveSnapshot(p, [makeEvent(C0, 0)]);

    const tampered = JSON.parse(fs.readFileSync(p, "utf-8"));
    tampered.last_root_be_hex =
      "0000000000000000000000000000000000000000000000000000000000000001";
    fs.writeFileSync(p, JSON.stringify(tampered), "utf-8");

    expect(() => loadSnapshot(p)).to.throw("root mismatch");
    fs.unlinkSync(p);
  });

  it("loadSnapshot rejects leaf_count mismatch (tampered leaf_count)", () => {
    const p = tmpPath();
    saveSnapshot(p, [makeEvent(C0, 0)]);

    const tampered = JSON.parse(fs.readFileSync(p, "utf-8"));
    tampered.leaf_count = 99;
    fs.writeFileSync(p, JSON.stringify(tampered), "utf-8");

    expect(() => loadSnapshot(p)).to.throw("leaf_count mismatch");
    fs.unlinkSync(p);
  });

  it("loadSnapshot rejects out-of-order events via expectedLeafIndex mismatch during replay", () => {
    const p = tmpPath();
    // Write raw JSON with events in wrong order: leaf_index=1 before leaf_index=0.
    const bad = {
      version: 1,
      tree_depth: TREE_DEPTH,
      events: [
        serializeEvent(makeEvent(C1, 1)), // wrong: leaf_index=1 first
        serializeEvent(makeEvent(C0, 0)),
      ],
      last_root_be_hex: EMPTY_SUBTREES[TREE_DEPTH],
      leaf_count: 2,
    };
    fs.writeFileSync(p, JSON.stringify(bad), "utf-8");
    expect(() => loadSnapshot(p)).to.throw("expectedLeafIndex");
    fs.unlinkSync(p);
  });

  it("loadSnapshot rejects malformed event (non-numeric denomination)", () => {
    const p = tmpPath();
    const bad = {
      version: 1,
      tree_depth: TREE_DEPTH,
      events: [
        {
          commitment_be_hex: C0,
          denomination: "not_a_number",
          leaf_index: 0,
          depositor: DEPOSITOR,
          slot: "100",
        },
      ],
      last_root_be_hex: EMPTY_SUBTREES[TREE_DEPTH],
      leaf_count: 1,
    };
    fs.writeFileSync(p, JSON.stringify(bad), "utf-8");
    expect(() => loadSnapshot(p)).to.throw("deserialization");
    fs.unlinkSync(p);
  });

  it("loadSnapshot rejects invalid JSON", () => {
    const p = tmpPath();
    fs.writeFileSync(p, "{ this is not valid json }", "utf-8");
    expect(() => loadSnapshot(p)).to.throw("invalid JSON");
    fs.unlinkSync(p);
  });

  it("loadSnapshot rejects malformed commitment_be_hex (0x prefix)", () => {
    const p = tmpPath();
    const bad = {
      version: 1,
      tree_depth: TREE_DEPTH,
      events: [
        {
          commitment_be_hex: "0x" + C0,
          denomination: "100000000",
          leaf_index: 0,
          depositor: DEPOSITOR,
          slot: "100",
        },
      ],
      last_root_be_hex: EMPTY_SUBTREES[TREE_DEPTH],
      leaf_count: 1,
    };
    fs.writeFileSync(p, JSON.stringify(bad), "utf-8");
    expect(() => loadSnapshot(p)).to.throw("0x prefix");
    fs.unlinkSync(p);
  });

  it("loadSnapshot rejects negative denomination", () => {
    const p = tmpPath();
    const bad = {
      version: 1,
      tree_depth: TREE_DEPTH,
      events: [
        {
          commitment_be_hex: C0,
          denomination: "-1",
          leaf_index: 0,
          depositor: DEPOSITOR,
          slot: "100",
        },
      ],
      last_root_be_hex: EMPTY_SUBTREES[TREE_DEPTH],
      leaf_count: 1,
    };
    fs.writeFileSync(p, JSON.stringify(bad), "utf-8");
    expect(() => loadSnapshot(p)).to.throw("non-negative");
    fs.unlinkSync(p);
  });

  it("loadSnapshot rejects invalid log_index (negative)", () => {
    const p = tmpPath();
    const bad = {
      version: 1,
      tree_depth: TREE_DEPTH,
      events: [
        {
          commitment_be_hex: C0,
          denomination: "100000000",
          leaf_index: 0,
          depositor: DEPOSITOR,
          slot: "100",
          log_index: -1,
        },
      ],
      last_root_be_hex: EMPTY_SUBTREES[TREE_DEPTH],
      leaf_count: 1,
    };
    fs.writeFileSync(p, JSON.stringify(bad), "utf-8");
    expect(() => loadSnapshot(p)).to.throw("log_index");
    fs.unlinkSync(p);
  });

  // ── SnapshotFetchMeta / version 2 ────────────────────────────────────────────

  it("buildSnapshot without meta: version=1, no meta field in result", () => {
    const snapshot = buildSnapshot([makeEvent(C0, 0)]);
    expect(snapshot.version).to.equal(1);
    expect(snapshot).to.not.have.property("meta");
  });

  it("buildSnapshot with meta: version=2, meta fields match", () => {
    const meta: SnapshotFetchMeta = {
      fetch_commitment: "confirmed",
      source_mode: "address",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const snapshot = buildSnapshot([makeEvent(C0, 0)], meta);
    expect(snapshot.version).to.equal(2);
    expect(snapshot.meta).to.exist;
    expect(snapshot.meta!.fetch_commitment).to.equal("confirmed");
    expect(snapshot.meta!.source_mode).to.equal("address");
    expect(snapshot.meta!.created_at).to.equal("2026-01-01T00:00:00.000Z");
  });

  it("saveSnapshot with meta: written file has version 2 and meta field", () => {
    const p = tmpPath();
    const meta: SnapshotFetchMeta = {
      fetch_commitment: "finalized",
      source_mode: "exact-signature",
    };
    saveSnapshot(p, [makeEvent(C0, 0)], meta);
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(parsed.version).to.equal(2);
    expect(parsed.meta).to.exist;
    expect(parsed.meta.fetch_commitment).to.equal("finalized");
    expect(parsed.meta.source_mode).to.equal("exact-signature");
    fs.unlinkSync(p);
  });

  it("loadSnapshot accepts version 2 snapshot: tree, root, leaf_count all valid", () => {
    const p = tmpPath();
    const events = [makeEvent(C0, 0), makeEvent(C1, 1)];
    const meta: SnapshotFetchMeta = {
      fetch_commitment: "confirmed",
      source_mode: "address",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    saveSnapshot(p, events, meta);
    const { snapshot, tree } = loadSnapshot(p);
    expect(snapshot.version).to.equal(2);
    expect(snapshot.leaf_count).to.equal(2);
    expect(tree.getLeafCount()).to.equal(2);
    expect(tree.getRoot()).to.equal(snapshot.last_root_be_hex);
    fs.unlinkSync(p);
  });

  it("loadSnapshot v2: snapshot.meta is preserved and accessible", () => {
    const p = tmpPath();
    const meta: SnapshotFetchMeta = {
      fetch_commitment: "confirmed",
      source_mode: "exact-signature",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    saveSnapshot(p, [makeEvent(C0, 0)], meta);
    const { snapshot } = loadSnapshot(p);
    expect(snapshot.meta).to.exist;
    expect(snapshot.meta!.source_mode).to.equal("exact-signature");
    expect(snapshot.meta!.created_at).to.equal("2026-01-01T00:00:00.000Z");
    fs.unlinkSync(p);
  });
});
