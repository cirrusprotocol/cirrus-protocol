import { expect } from "chai";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import { IncrementalMerkleTree } from "../lib/zk_indexer/incremental_tree";
import {
  sortEventsForReplay,
  replayNoteDeposits,
} from "../lib/zk_indexer/event_log";
import { EMPTY_SUBTREES, TREE_DEPTH } from "../lib/zk_indexer/constants";
import {
  TransactionEventFixture,
  parseEventJsonLogLine,
  extractNoteDepositedEventsFromFixture,
  extractNoteDepositedEventsFromFixtures,
} from "../lib/zk_indexer/log_parser";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DEPOSITOR = "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe";
const C0 = "0101010101010101010101010101010101010101010101010101010101010101";
const C1 = "0202020202020202020202020202020202020202020202020202020202020202";

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

function logLine(eventObj: Record<string, unknown>): string {
  return `Program log: EVENT_JSON:${JSON.stringify(eventObj)}`;
}

// ── parseEventJsonLogLine ─────────────────────────────────────────────────────

describe("zk_indexer: log_parser — parseEventJsonLogLine", function () {
  it("1. returns null for normal log line without EVENT_JSON", () => {
    expect(parseEventJsonLogLine("Program log: Instruction: DepositNote")).to.be
      .null;
    expect(parseEventJsonLogLine("")).to.be.null;
    expect(parseEventJsonLogLine("Program log: some arbitrary text")).to.be
      .null;
  });

  it("2. parses valid EVENT_JSON noteDeposited line", () => {
    const data = noteData(C0, 0);
    const line = `Program log: EVENT_JSON:${JSON.stringify({
      name: "noteDeposited",
      data,
    })}`;
    const result = parseEventJsonLogLine(line);
    expect(result).to.not.be.null;
    expect(result!.name).to.equal("noteDeposited");
    expect((result!.data as Record<string, unknown>)["commitment"]).to.equal(
      C0
    );
  });

  it("3. rejects malformed EVENT_JSON JSON", () => {
    expect(() =>
      parseEventJsonLogLine("Program log: EVENT_JSON:{invalid json here")
    ).to.throw("malformed JSON");
  });

  it("4. rejects EVENT_JSON object missing name field", () => {
    const line = `Program log: EVENT_JSON:${JSON.stringify({
      data: noteData(C0, 0),
    })}`;
    expect(() => parseEventJsonLogLine(line)).to.throw("name");
  });

  it("5. rejects EVENT_JSON object missing data field", () => {
    const line = `Program log: EVENT_JSON:${JSON.stringify({
      name: "noteDeposited",
    })}`;
    expect(() => parseEventJsonLogLine(line)).to.throw("data");
  });
});

// ── extractNoteDepositedEventsFromFixture ─────────────────────────────────────

describe("zk_indexer: log_parser — extractNoteDepositedEventsFromFixture", function () {
  it("6. extracts from EventParser-like events array", () => {
    const fixture: TransactionEventFixture = {
      events: [{ name: "noteDeposited", data: noteData(C0, 0) }],
    };
    const result = extractNoteDepositedEventsFromFixture(fixture);
    expect(result).to.have.length(1);
    expect(result[0].commitment_be_hex).to.equal(C0);
    expect(result[0].leaf_index).to.equal(0);
  });

  it('7. accepts both "noteDeposited" and "NoteDeposited" event names', () => {
    const fixture: TransactionEventFixture = {
      events: [
        { name: "noteDeposited", data: noteData(C0, 0) },
        { name: "NoteDeposited", data: noteData(C1, 1) },
      ],
    };
    const result = extractNoteDepositedEventsFromFixture(fixture);
    expect(result).to.have.length(2);
    expect(result[0].commitment_be_hex).to.equal(C0);
    expect(result[1].commitment_be_hex).to.equal(C1);
  });

  it("8. ignores unrelated event names", () => {
    const fixture: TransactionEventFixture = {
      events: [
        { name: "noteDeposited", data: noteData(C0, 0) },
        { name: "SomeOtherEvent", data: { irrelevant: true } },
        { name: "noteDeposited", data: noteData(C1, 1) },
      ],
    };
    const result = extractNoteDepositedEventsFromFixture(fixture);
    expect(result).to.have.length(2);
    expect(result[0].commitment_be_hex).to.equal(C0);
    expect(result[1].commitment_be_hex).to.equal(C1);
  });

  it("9. extracts from logs using EVENT_JSON marker", () => {
    const fixture: TransactionEventFixture = {
      logs: [
        "Program log: Instruction: DepositNote",
        logLine({ name: "noteDeposited", data: noteData(C0, 0) }),
      ],
    };
    const result = extractNoteDepositedEventsFromFixture(fixture);
    expect(result).to.have.length(1);
    expect(result[0].commitment_be_hex).to.equal(C0);
  });

  it("10. attaches fixture.signature if event data has no signature", () => {
    const fixture: TransactionEventFixture = {
      signature: "txSig123",
      events: [{ name: "noteDeposited", data: noteData(C0, 0) }],
    };
    const result = extractNoteDepositedEventsFromFixture(fixture);
    expect(result[0].signature).to.equal("txSig123");
  });

  it("11. keeps event-provided signature instead of overwriting with fixture.signature", () => {
    const fixture: TransactionEventFixture = {
      signature: "fixtureSignature",
      events: [
        {
          name: "noteDeposited",
          data: noteData(C0, 0, { signature: "eventSignature" }),
        },
      ],
    };
    const result = extractNoteDepositedEventsFromFixture(fixture);
    expect(result[0].signature).to.equal("eventSignature");
  });

  it("12. uses fixture.slot as fallback when event data has no slot", () => {
    const dataNoSlot: Record<string, unknown> = {
      commitment: C0,
      denomination: "100000000",
      leafIndex: 0,
      depositor: DEPOSITOR,
      // slot deliberately absent
    };
    const fixture: TransactionEventFixture = {
      slot: "999",
      events: [{ name: "noteDeposited", data: dataNoSlot }],
    };
    const result = extractNoteDepositedEventsFromFixture(fixture);
    expect(result[0].slot).to.equal(999n);
  });

  it("13. keeps event-provided slot when fixture.slot would otherwise apply", () => {
    const fixture: TransactionEventFixture = {
      slot: "999",
      events: [
        { name: "noteDeposited", data: noteData(C0, 0, { slot: "42" }) },
      ],
    };
    const result = extractNoteDepositedEventsFromFixture(fixture);
    expect(result[0].slot).to.equal(42n);
  });

  it("14. for logs, attaches log_index as original log line index", () => {
    const fixture: TransactionEventFixture = {
      logs: [
        "Program log: unrelated line", // index 0
        logLine({ name: "noteDeposited", data: noteData(C0, 0) }), // index 1
      ],
    };
    const result = extractNoteDepositedEventsFromFixture(fixture);
    expect(result).to.have.length(1);
    expect(result[0].log_index).to.equal(1);
  });

  it("15. does not overwrite event-provided log_index with log line index", () => {
    const fixture: TransactionEventFixture = {
      logs: [
        "Program log: unrelated line", // index 0
        logLine({
          name: "noteDeposited",
          data: noteData(C0, 0, { log_index: 7 }),
        }), // index 1, event has log_index 7
      ],
    };
    const result = extractNoteDepositedEventsFromFixture(fixture);
    expect(result[0].log_index).to.equal(7);
  });

  it("16. returns [] for fixture with no matching events", () => {
    expect(
      extractNoteDepositedEventsFromFixture({
        events: [{ name: "SomeOtherEvent", data: {} }],
      })
    ).to.deep.equal([]);
    expect(extractNoteDepositedEventsFromFixture({})).to.deep.equal([]);
    expect(
      extractNoteDepositedEventsFromFixture({
        logs: ["Program log: no event json here"],
      })
    ).to.deep.equal([]);
  });

  it("17. throws contextual error for malformed event data in events array", () => {
    const fixture: TransactionEventFixture = {
      events: [
        {
          name: "noteDeposited",
          data: {
            // commitment deliberately absent
            denomination: "100000000",
            leafIndex: 0,
            depositor: DEPOSITOR,
            slot: "100",
          },
        },
      ],
    };
    expect(() => extractNoteDepositedEventsFromFixture(fixture)).to.throw(
      "events[0]"
    );
  });

  it("18. throws contextual error for malformed event data in logs", () => {
    const fixture: TransactionEventFixture = {
      logs: [
        logLine({
          name: "noteDeposited",
          data: {
            // commitment deliberately absent
            denomination: "100000000",
            leafIndex: 0,
            depositor: DEPOSITOR,
            slot: "100",
          },
        }),
      ],
    };
    expect(() => extractNoteDepositedEventsFromFixture(fixture)).to.throw(
      "logs[0]"
    );
  });
});

// ── extractNoteDepositedEventsFromFixtures ────────────────────────────────────

describe("zk_indexer: log_parser — extractNoteDepositedEventsFromFixtures", function () {
  it("19. flattens multiple fixtures in input order", () => {
    const fixtures: TransactionEventFixture[] = [
      { events: [{ name: "noteDeposited", data: noteData(C0, 0) }] },
      { events: [{ name: "noteDeposited", data: noteData(C1, 1) }] },
    ];
    const result = extractNoteDepositedEventsFromFixtures(fixtures);
    expect(result).to.have.length(2);
    expect(result[0].commitment_be_hex).to.equal(C0);
    expect(result[1].commitment_be_hex).to.equal(C1);
  });

  it("20. does not sort by leaf_index — preserves extraction order", () => {
    const fixtures: TransactionEventFixture[] = [
      { events: [{ name: "noteDeposited", data: noteData(C1, 1) }] }, // leaf 1 first
      { events: [{ name: "noteDeposited", data: noteData(C0, 0) }] }, // leaf 0 second
    ];
    const result = extractNoteDepositedEventsFromFixtures(fixtures);
    expect(result[0].leaf_index).to.equal(1);
    expect(result[1].leaf_index).to.equal(0);
  });
});

// ── Integration ───────────────────────────────────────────────────────────────

describe("zk_indexer: log_parser — integration", function () {
  this.timeout(60_000);

  before(async () => {
    await initPoseidon();
  });

  it("21. extract from two fixtures, sort and replay: leaf_count=2, root matches tree", () => {
    const fixtures: TransactionEventFixture[] = [
      { events: [{ name: "noteDeposited", data: noteData(C1, 1) }] }, // leaf 1
      { events: [{ name: "noteDeposited", data: noteData(C0, 0) }] }, // leaf 0
    ];

    const extracted = extractNoteDepositedEventsFromFixtures(fixtures);
    expect(extracted).to.have.length(2);

    const sorted = sortEventsForReplay(extracted);
    const tree = new IncrementalMerkleTree();
    const result = replayNoteDeposits(tree, sorted);

    expect(result.inserted).to.equal(2);
    expect(result.leaf_count).to.equal(2);
    expect(result.root_be_hex).to.equal(tree.getRoot());
    expect(result.root_be_hex).to.not.equal(EMPTY_SUBTREES[TREE_DEPTH]);
  });

  it("22. extraction preserves unsorted order; sortEventsForReplay corrects it", () => {
    const fixtures: TransactionEventFixture[] = [
      { events: [{ name: "noteDeposited", data: noteData(C1, 1) }] }, // leaf 1
      { events: [{ name: "noteDeposited", data: noteData(C0, 0) }] }, // leaf 0
    ];

    const extracted = extractNoteDepositedEventsFromFixtures(fixtures);
    // Extraction preserves fixture input order: leaf 1 before leaf 0
    expect(extracted[0].leaf_index).to.equal(1);
    expect(extracted[1].leaf_index).to.equal(0);

    // sortEventsForReplay then corrects the order for replay
    const sorted = sortEventsForReplay(extracted);
    expect(sorted[0].leaf_index).to.equal(0);
    expect(sorted[1].leaf_index).to.equal(1);
  });
});
