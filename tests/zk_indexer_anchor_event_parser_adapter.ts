// Tests for the Anchor EventParser adapter boundary.
//
// Option A: @anchor-lang/core is available; tests use real BorshCoder/EventParser
// with fixture log lines built from known-good Borsh-encoded NoteDeposited events.
//
// No real RPC. No Connection. All fixtures are locally constructed base64 strings.
// No solana-test-validator required.

import { strict as assert } from "assert";
import {
  createAnchorEventParserLikeFromIdl,
  createAnchorEventParserLogDecoderFromIdl,
  AnchorParserFactoryArgs,
} from "../lib/zk_indexer/anchor_event_parser_adapter";
import { extractNoteDepositedEventsFromDecodedEvents } from "../lib/zk_indexer/event_decoder";

// ── Constants ─────────────────────────────────────────────────────────────────

const PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";

// IDL loaded from local file — no RPC, no network.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const IDL = require("../idl/shielded_pool_anchor.json") as unknown;

const FACTORY_ARGS: AnchorParserFactoryArgs = {
  programId: PROGRAM_ID,
  idl: IDL,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// Pre-encoded NoteDeposited events:
//
//   FIXTURE_1: commitment[31]=0xab, denomination=1_000_000_000, leaf_index=3,
//              depositor bytes[0]=2, slot=99999
//   FIXTURE_2: commitment[31]=0xcd, denomination=500_000_000, leaf_index=1,
//              depositor bytes[0]=3, slot=100001
//
// Each base64 encodes: 8-byte discriminator + 32-byte commitment + 8-byte
// denomination (u64 LE) + 8-byte leaf_index (u64 LE) + 32-byte depositor pubkey
// + 8-byte slot (u64 LE) = 96 bytes total.
//
// Discriminator for NoteDeposited: [27,177,212,105,19,136,143,45]

const FIXTURE_1_B64 =
  "G7HUaROIjy0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqwDKmjsAAAAAAwAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ+GAQAAAAAA";
const FIXTURE_1_COMMITMENT_HEX =
  "00000000000000000000000000000000000000000000000000000000000000ab";
const FIXTURE_1_DENOMINATION = 1_000_000_000n;
const FIXTURE_1_LEAF_INDEX = 3;
const FIXTURE_1_DEPOSITOR = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
const FIXTURE_1_SLOT = 99999n;

const FIXTURE_2_B64 =
  "G7HUaROIjy0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzQBlzR0AAAAAAQAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKGGAQAAAAAA";
const FIXTURE_2_COMMITMENT_HEX =
  "00000000000000000000000000000000000000000000000000000000000000cd";
const FIXTURE_2_DENOMINATION = 500_000_000n;
const FIXTURE_2_LEAF_INDEX = 1;
const FIXTURE_2_DEPOSITOR = "CiDwVBFgWV9E5MvXWoLgnEgn2hK7rJikbvfWavzAQz3";
const FIXTURE_2_SLOT = 100001n;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAnchorLogs(programId: string, ...b64Events: string[]): string[] {
  const logs: string[] = [`Program ${programId} invoke [1]`];
  for (const b64 of b64Events) {
    logs.push(`Program data: ${b64}`);
  }
  logs.push(`Program ${programId} success`);
  return logs;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Anchor EventParser adapter (local, no RPC)", () => {
  // ── Group 1: Adapter construction ───────────────────────────────────────────

  it("1. module imports cleanly without constructing Connection or triggering RPC", () => {
    // The adapter module should be importable without side effects. The imports
    // above (createAnchorEventParserLikeFromIdl etc.) succeed without error.
    assert.equal(typeof createAnchorEventParserLikeFromIdl, "function");
    assert.equal(typeof createAnchorEventParserLogDecoderFromIdl, "function");
  });

  it("2. createAnchorEventParserLikeFromIdl returns an AnchorEventParserLike from local IDL", () => {
    const parser = createAnchorEventParserLikeFromIdl(FACTORY_ARGS);
    assert.equal(typeof parser, "object");
    assert.equal(typeof parser.parseLogs, "function");
  });

  it("3. createAnchorEventParserLogDecoderFromIdl returns a LogDecoder named 'anchor_event_parser'", () => {
    const decoder = createAnchorEventParserLogDecoderFromIdl(FACTORY_ARGS);
    assert.equal(typeof decoder, "object");
    assert.equal(decoder.name, "anchor_event_parser");
    assert.equal(typeof decoder.decodeLogs, "function");
  });

  // ── Group 2: Parsing events ──────────────────────────────────────────────────

  it("4. parseLogs([]) yields no events", () => {
    const decoder = createAnchorEventParserLogDecoderFromIdl(FACTORY_ARGS);
    const events = decoder.decodeLogs({ logs: [] });
    assert.equal(events.length, 0);
  });

  it("5. parseLogs with logs from a different program yields no events", () => {
    const decoder = createAnchorEventParserLogDecoderFromIdl(FACTORY_ARGS);
    const otherProgram = "11111111111111111111111111111111";
    const logs = makeAnchorLogs(otherProgram, FIXTURE_1_B64);
    const events = decoder.decodeLogs({ logs });
    assert.equal(events.length, 0);
  });

  it("6. parseLogs with FIXTURE_1 produces 1 DecodedProgramEvent", () => {
    const decoder = createAnchorEventParserLogDecoderFromIdl(FACTORY_ARGS);
    const logs = makeAnchorLogs(PROGRAM_ID, FIXTURE_1_B64);
    const events = decoder.decodeLogs({
      logs,
      signature: "sig1",
      slot: 99999n,
    });
    assert.equal(events.length, 1);
  });

  it("7. decoded event has name 'NoteDeposited', source 'anchor_event_parser', and BN/PublicKey-typed fields", () => {
    const decoder = createAnchorEventParserLogDecoderFromIdl(FACTORY_ARGS);
    const logs = makeAnchorLogs(PROGRAM_ID, FIXTURE_1_B64);
    const [ev] = decoder.decodeLogs({ logs, signature: "sig1", slot: 99999n });

    assert.equal(ev.name, "NoteDeposited");
    assert.equal(ev.source, "anchor_event_parser");
    assert.equal(ev.signature, "sig1");
    assert.equal(ev.slot, 99999n);

    const d = ev.data as Record<string, unknown>;
    // commitment is a 32-element number array
    assert.ok(Array.isArray(d["commitment"]), "commitment should be an array");
    assert.equal((d["commitment"] as number[]).length, 32);
    // denomination is BN-like: has toString()
    assert.ok(
      typeof d["denomination"] === "object" &&
        d["denomination"] !== null &&
        typeof (d["denomination"] as { toString(): string }).toString ===
          "function",
      "denomination should be BN-like"
    );
    assert.equal(
      (d["denomination"] as { toString(): string }).toString(),
      "1000000000"
    );
    // depositor is PublicKey-like: has toBase58()
    assert.ok(
      typeof d["depositor"] === "object" &&
        d["depositor"] !== null &&
        typeof (d["depositor"] as { toBase58(): string }).toBase58 ===
          "function",
      "depositor should be PublicKey-like"
    );
    assert.equal(
      (d["depositor"] as { toBase58(): string }).toBase58(),
      FIXTURE_1_DEPOSITOR
    );
  });

  // ── Group 3: Full pipeline to NormalizedNoteDepositedEvent ───────────────────

  it("8. full pipeline FIXTURE_1: NormalizedNoteDepositedEvent has correct commitment, denomination, leaf_index, depositor, slot", () => {
    const decoder = createAnchorEventParserLogDecoderFromIdl(FACTORY_ARGS);
    const logs = makeAnchorLogs(PROGRAM_ID, FIXTURE_1_B64);
    const decoded = decoder.decodeLogs({
      logs,
      signature: "sig1",
      slot: FIXTURE_1_SLOT,
    });
    const normalized = extractNoteDepositedEventsFromDecodedEvents(decoded);

    assert.equal(normalized.length, 1);
    const n = normalized[0];
    assert.equal(n.commitment_be_hex, FIXTURE_1_COMMITMENT_HEX);
    assert.equal(n.denomination, FIXTURE_1_DENOMINATION);
    assert.equal(n.leaf_index, FIXTURE_1_LEAF_INDEX);
    assert.equal(n.depositor, FIXTURE_1_DEPOSITOR);
    assert.equal(n.slot, FIXTURE_1_SLOT);
    assert.equal(n.signature, "sig1");
  });

  it("9. full pipeline FIXTURE_2: NormalizedNoteDepositedEvent has correct fields", () => {
    const decoder = createAnchorEventParserLogDecoderFromIdl(FACTORY_ARGS);
    const logs = makeAnchorLogs(PROGRAM_ID, FIXTURE_2_B64);
    const decoded = decoder.decodeLogs({
      logs,
      signature: "sig2",
      slot: FIXTURE_2_SLOT,
    });
    const normalized = extractNoteDepositedEventsFromDecodedEvents(decoded);

    assert.equal(normalized.length, 1);
    const n = normalized[0];
    assert.equal(n.commitment_be_hex, FIXTURE_2_COMMITMENT_HEX);
    assert.equal(n.denomination, FIXTURE_2_DENOMINATION);
    assert.equal(n.leaf_index, FIXTURE_2_LEAF_INDEX);
    assert.equal(n.depositor, FIXTURE_2_DEPOSITOR);
    assert.equal(n.slot, FIXTURE_2_SLOT);
    assert.equal(n.signature, "sig2");
  });

  it("10. two NoteDeposited events in one log stream are both decoded and normalized in order", () => {
    const decoder = createAnchorEventParserLogDecoderFromIdl(FACTORY_ARGS);
    // FIXTURE_2 (leaf_index=1) before FIXTURE_1 (leaf_index=3) to test that
    // output order matches input log order, not field order.
    const logs = makeAnchorLogs(PROGRAM_ID, FIXTURE_2_B64, FIXTURE_1_B64);
    const decoded = decoder.decodeLogs({
      logs,
      signature: "sigA",
      slot: 200000n,
    });
    assert.equal(decoded.length, 2);

    const normalized = extractNoteDepositedEventsFromDecodedEvents(decoded);
    assert.equal(normalized.length, 2);

    // First event: FIXTURE_2
    assert.equal(normalized[0].commitment_be_hex, FIXTURE_2_COMMITMENT_HEX);
    assert.equal(normalized[0].leaf_index, FIXTURE_2_LEAF_INDEX);

    // Second event: FIXTURE_1
    assert.equal(normalized[1].commitment_be_hex, FIXTURE_1_COMMITMENT_HEX);
    assert.equal(normalized[1].leaf_index, FIXTURE_1_LEAF_INDEX);
  });
});
