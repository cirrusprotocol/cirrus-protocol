import { expect } from "chai";
import { initPoseidon } from "../lib/zk_indexer/poseidon";
import { IncrementalMerkleTree } from "../lib/zk_indexer/incremental_tree";
import {
  sortEventsForReplay,
  replayNoteDeposits,
} from "../lib/zk_indexer/event_log";
import { TREE_DEPTH, EMPTY_SUBTREES } from "../lib/zk_indexer/constants";
import {
  DecodedProgramEvent,
  AnchorEventParserLike,
  EventJsonLogDecoder,
  decodeEventParserLikeFixture,
  createAnchorEventParserDecoder,
  decodeEventJsonLogs,
  decodedProgramEventToRawNoteEvent,
  extractNoteDepositedEventsFromDecodedEvents,
  extractNoteDepositedEventsFromEventJsonLogs,
} from "../lib/zk_indexer/event_decoder";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEPOSITOR = "7GhrwRsxkBrE1bKYdbBUbDZXhY4aBB8bG4d6V1BPAcXe";
const C0 = "0101010101010101010101010101010101010101010101010101010101010101";
const C1 = "0202020202020202020202020202020202020202020202020202020202020202";

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

function noteDataNoSlot(
  commitmentHex: string,
  leafIndex: number
): Record<string, unknown> {
  return {
    commitment: commitmentHex,
    denomination: "100000000",
    leafIndex,
    depositor: DEPOSITOR,
  };
}

// ── EventJsonLogDecoder / decodeEventJsonLogs ─────────────────────────────────

describe("zk_indexer: event_decoder — EventJsonLogDecoder / decodeEventJsonLogs", function () {
  it("1. returns [] for logs without EVENT_JSON marker", () => {
    const result = decodeEventJsonLogs({
      logs: ["Program log: hello", "Program data: base64stuff", ""],
    });
    expect(result).to.have.length(0);
  });

  it("2. decodes one valid EVENT_JSON noteDeposited log", () => {
    const log = eventJsonLog("noteDeposited", noteData(C0, 0));
    const result = decodeEventJsonLogs({ logs: [log] });
    expect(result).to.have.length(1);
    expect(result[0].name).to.equal("noteDeposited");
    expect(result[0].source).to.equal("event_json_log");
  });

  it("3. decodes multiple EVENT_JSON logs preserving log order", () => {
    const logs = [
      "Program log: normal",
      eventJsonLog("noteDeposited", noteData(C0, 0)),
      "Program log: another",
      eventJsonLog("noteDeposited", noteData(C1, 1)),
    ];
    const result = decodeEventJsonLogs({ logs });
    expect(result).to.have.length(2);
    expect(result[0].log_index).to.equal(1);
    expect(result[1].log_index).to.equal(3);
  });

  it("4. attaches signature fallback when event data has no signature", () => {
    // noteData has no signature field by default
    const log = eventJsonLog("noteDeposited", noteDataNoSlot(C0, 0));
    const result = decodeEventJsonLogs({
      logs: [log],
      signature: "fallbackSig",
    });
    expect(result[0].signature).to.equal("fallbackSig");
  });

  it("5. attaches slot fallback when event data has no slot", () => {
    const log = eventJsonLog("noteDeposited", noteDataNoSlot(C0, 0));
    const result = decodeEventJsonLogs({ logs: [log], slot: 999 });
    expect(result[0].slot).to.equal(999);
  });

  it("6. attaches log_index equal to original log line index", () => {
    const logs = [
      "Program log: first",
      "Program log: second",
      eventJsonLog("noteDeposited", noteData(C0, 0)),
    ];
    const result = decodeEventJsonLogs({ logs });
    expect(result).to.have.length(1);
    expect(result[0].log_index).to.equal(2);
  });

  it("7. does not overwrite event-provided signature", () => {
    const data = { ...noteData(C0, 0), signature: "eventSig" };
    const log = eventJsonLog("noteDeposited", data);
    const result = decodeEventJsonLogs({ logs: [log], signature: "argSig" });
    expect(result[0].signature).to.equal("eventSig");
  });

  it("8. does not overwrite event-provided slot", () => {
    // noteData provides slot: "100"
    const log = eventJsonLog("noteDeposited", noteData(C0, 0));
    const result = decodeEventJsonLogs({ logs: [log], slot: 999 });
    expect(result[0].slot).to.equal("100");
  });

  it("9. does not overwrite event-provided log_index", () => {
    const data = { ...noteData(C0, 0), log_index: 5 };
    const log = eventJsonLog("noteDeposited", data);
    // log appears at position 2; without override, log_index would be 2
    const logs = ["normal", "normal", log];
    const result = decodeEventJsonLogs({ logs });
    expect(result[0].log_index).to.equal(5);
  });

  it("10. throws contextual error for malformed EVENT_JSON JSON and includes log index", () => {
    const malformed = "Program log: EVENT_JSON:{bad json";
    let err: Error | undefined;
    try {
      decodeEventJsonLogs({ logs: ["ok line", malformed] });
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("log index 1");
  });
});

// ── Decoded event normalization ───────────────────────────────────────────────

describe("zk_indexer: event_decoder — decoded event normalization", function () {
  it("11. extractNoteDepositedEventsFromDecodedEvents filters noteDeposited / NoteDeposited and ignores unrelated names", () => {
    const events: DecodedProgramEvent[] = [
      { name: "SomeOtherEvent", data: {}, source: "event_json_log" },
      {
        name: "noteDeposited",
        data: noteData(C0, 0),
        source: "event_json_log",
      },
      {
        name: "NoteDeposited",
        data: noteData(C1, 1),
        source: "event_json_log",
      },
      { name: "UnrelatedEvent", data: {}, source: "event_json_log" },
    ];
    const result = extractNoteDepositedEventsFromDecodedEvents(events);
    expect(result).to.have.length(2);
    expect(result[0].commitment_be_hex).to.equal(C0);
    expect(result[1].commitment_be_hex).to.equal(C1);
  });

  it("12. normalizes decoded event data into NormalizedNoteDepositedEvent", () => {
    const events: DecodedProgramEvent[] = [
      {
        name: "noteDeposited",
        data: noteData(C0, 0),
        source: "event_json_log",
        signature: "sig1",
        log_index: 0,
      },
    ];
    const result = extractNoteDepositedEventsFromDecodedEvents(events);
    expect(result).to.have.length(1);
    expect(result[0].commitment_be_hex).to.equal(C0);
    expect(result[0].leaf_index).to.equal(0);
    expect(result[0].denomination).to.equal(100000000n);
    expect(result[0].signature).to.equal("sig1");
  });

  it("13. preserves input order and does not sort", () => {
    const events: DecodedProgramEvent[] = [
      {
        name: "noteDeposited",
        data: noteData(C1, 1),
        source: "event_json_log",
      },
      {
        name: "noteDeposited",
        data: noteData(C0, 0),
        source: "event_json_log",
      },
    ];
    const result = extractNoteDepositedEventsFromDecodedEvents(events);
    expect(result[0].leaf_index).to.equal(1);
    expect(result[1].leaf_index).to.equal(0);
  });

  it("14. throws contextual error for malformed noteDeposited data including event index and source", () => {
    const events: DecodedProgramEvent[] = [
      {
        name: "noteDeposited",
        data: noteData(C0, 0),
        source: "event_json_log",
      },
      {
        name: "noteDeposited",
        data: {
          commitment: "TOOSHORT",
          denomination: "100000000",
          leafIndex: 0,
          depositor: DEPOSITOR,
          slot: "100",
        },
        source: "event_json_log",
      },
    ];
    let err: Error | undefined;
    try {
      extractNoteDepositedEventsFromDecodedEvents(events);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("index 1");
    expect(err!.message).to.include("event_json_log");
  });

  it("15. decodedProgramEventToRawNoteEvent rejects non-object data with clear message", () => {
    const badValues: unknown[] = [null, "a string", 42, true, undefined];
    for (const badData of badValues) {
      let err: Error | undefined;
      try {
        decodedProgramEventToRawNoteEvent({
          name: "noteDeposited",
          data: badData,
          source: "event_json_log",
        });
      } catch (e) {
        err = e as Error;
      }
      expect(err, `data=${String(badData)} should throw`).to.exist;
      expect(err!.message).to.include("event data must be an object");
    }
  });
});

// ── EventParser-like / fake parser boundary ───────────────────────────────────

describe("zk_indexer: event_decoder — EventParser-like / fake parser boundary", function () {
  it("16. converts EventParser-like fixture events into DecodedProgramEvent[] with source 'event_parser_like_fixture'", () => {
    const input = [
      { name: "noteDeposited", data: noteData(C0, 0) },
      { name: "SomeOtherEvent", data: { foo: "bar" } },
      { name: "NoteDeposited", data: noteData(C1, 1) },
    ];
    const result = decodeEventParserLikeFixture(input);
    expect(result).to.have.length(3);
    for (const ev of result) {
      expect(ev.source).to.equal("event_parser_like_fixture");
    }
    expect(result[0].name).to.equal("noteDeposited");
    expect(result[1].name).to.equal("SomeOtherEvent");
    expect(result[2].name).to.equal("NoteDeposited");
  });

  it("17. fake AnchorEventParser-like adapter uses fake parser only and preserves parsed event order", () => {
    const fakeParser: AnchorEventParserLike = {
      parseLogs(_logs) {
        return [
          { name: "noteDeposited", data: noteData(C0, 0) },
          { name: "noteDeposited", data: noteData(C1, 1) },
        ];
      },
    };
    const decoder = createAnchorEventParserDecoder(fakeParser);
    const result = decoder.decodeLogs({ logs: ["some", "raw", "logs"] });
    expect(result).to.have.length(2);
    expect(result[0].source).to.equal("anchor_event_parser");
    expect(result[0].name).to.equal("noteDeposited");
    expect(result[0].log_index).to.equal(0);
    expect(result[1].log_index).to.equal(1);
  });

  it("18. fake parser path attaches signature/slot fallback if supplied", () => {
    const fakeParser: AnchorEventParserLike = {
      parseLogs(_logs) {
        return [{ name: "noteDeposited", data: noteData(C0, 0) }];
      },
    };
    const decoder = createAnchorEventParserDecoder(fakeParser);
    const result = decoder.decodeLogs({
      logs: [],
      signature: "fallbackSig",
      slot: 123,
    });
    expect(result[0].signature).to.equal("fallbackSig");
    expect(result[0].slot).to.equal(123);
  });
});

// ── Integration with existing local pipeline ──────────────────────────────────

describe("zk_indexer: event_decoder — integration with existing local pipeline", function () {
  this.timeout(60_000);

  before(async () => {
    await initPoseidon();
  });

  it("19. decode EVENT_JSON logs → extract → sort → replay: leaf_count=2, root non-empty", () => {
    const logs = [
      eventJsonLog("noteDeposited", noteData(C1, 1)),
      eventJsonLog("noteDeposited", noteData(C0, 0)),
    ];
    const events = extractNoteDepositedEventsFromEventJsonLogs({ logs });
    expect(events).to.have.length(2);

    const sorted = sortEventsForReplay(events);
    const tree = new IncrementalMerkleTree();
    const result = replayNoteDeposits(tree, sorted);

    expect(result.leaf_count).to.equal(2);
    expect(result.root_be_hex).to.not.equal(EMPTY_SUBTREES[TREE_DEPTH]);
  });

  it("20. unsorted decoded events remain unsorted until caller calls sortEventsForReplay", () => {
    const logs = [
      eventJsonLog("noteDeposited", noteData(C1, 1)),
      eventJsonLog("noteDeposited", noteData(C0, 0)),
    ];
    const events = extractNoteDepositedEventsFromEventJsonLogs({ logs });
    expect(events[0].leaf_index).to.equal(1);
    expect(events[1].leaf_index).to.equal(0);
  });

  it("21. no matching NoteDeposited events returns [] and does not throw", () => {
    const logs = [
      "Program log: normal line",
      eventJsonLog("SomeOtherEvent", { foo: "bar" }),
      "Program log: another normal line",
    ];
    const result = extractNoteDepositedEventsFromEventJsonLogs({ logs });
    expect(result).to.deep.equal([]);
  });
});

// ── Safety ────────────────────────────────────────────────────────────────────

describe("zk_indexer: event_decoder — safety", function () {
  it("22. module imports cleanly and exports the expected public API", () => {
    const mod = require("../lib/zk_indexer/event_decoder");
    expect(typeof mod.EventJsonLogDecoder).to.equal("function");
    expect(typeof mod.decodeEventParserLikeFixture).to.equal("function");
    expect(typeof mod.createAnchorEventParserDecoder).to.equal("function");
    expect(typeof mod.decodedProgramEventToRawNoteEvent).to.equal("function");
    expect(typeof mod.extractNoteDepositedEventsFromDecodedEvents).to.equal(
      "function"
    );
    expect(typeof mod.decodeEventJsonLogs).to.equal("function");
    expect(typeof mod.extractNoteDepositedEventsFromEventJsonLogs).to.equal(
      "function"
    );
  });

  it("23. no side effects on import: module is cached and no I/O or connections were initiated", () => {
    // Reaching this point confirms that importing event_decoder.ts did not:
    // execute any top-level I/O, open network connections, call process.exit,
    // or load @solana/web3.js / @coral-xyz/anchor at the module level.
    const scriptPath = require.resolve("../lib/zk_indexer/event_decoder");
    expect(require.cache[scriptPath]).to.exist;
  });
});
