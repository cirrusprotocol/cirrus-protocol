// Anchor EventParser adapter for the ZK indexer.
//
// Constructs an AnchorEventParserLike from a local IDL using @anchor-lang/core's
// BorshCoder and EventParser. No Connection, no RPC, no module-level side effects.
//
// @anchor-lang/core is require()'d lazily inside factory functions. PublicKey is
// constructed only inside those functions, never at module top-level.
//
// This is the Option A integration: real BorshCoder/EventParser using the
// idl/shielded_pool_anchor.json fixture. Event data fields (BN, PublicKey) are
// handled by the existing normalizeNoteDepositedEvent normaliser.
//
// Pipeline shape:
//   Anchor base64 log lines
//   → createAnchorEventParserLikeFromIdl (BorshCoder + EventParser)
//   → AnchorEventParserLike.parseLogs
//   → createAnchorEventParserDecoder (wraps as LogDecoder, source "anchor_event_parser")
//   → decodeLogs → DecodedProgramEvent[]
//   → extractNoteDepositedEventsFromDecodedEvents → NormalizedNoteDepositedEvent[]

import {
  AnchorEventParserLike,
  LogDecoder,
  createAnchorEventParserDecoder,
} from "./event_decoder";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AnchorParserFactoryArgs {
  programId: string;
  idl: unknown;
}

// ── Factory functions ─────────────────────────────────────────────────────────

/**
 * Construct a real AnchorEventParserLike from a local IDL.
 *
 * Requires @anchor-lang/core (available as a project dependency). Lazily
 * require()'d to avoid module-level side effects. Constructs a BorshCoder from
 * the IDL and wraps an EventParser as an AnchorEventParserLike.
 *
 * No Connection is created. No live RPC is used. The resulting parser decodes
 * Anchor base64 event log lines against the IDL's event discriminators and
 * Borsh layouts.
 */
export function createAnchorEventParserLikeFromIdl(
  args: AnchorParserFactoryArgs
): AnchorEventParserLike {
  const { BorshCoder, EventParser, web3 } = require("@anchor-lang/core") as {
    BorshCoder: new (idl: unknown) => object;
    EventParser: new (programId: object, coder: object) => {
      parseLogs(logs: string[]): Iterable<{ name: string; data: unknown }>;
    };
    web3: { PublicKey: new (s: string) => object };
  };

  const programId = new web3.PublicKey(args.programId);
  const coder = new BorshCoder(args.idl);
  const parser = new EventParser(programId, coder);

  return {
    parseLogs(logs: string[]): Iterable<{ name: string; data: unknown }> {
      return parser.parseLogs(logs);
    },
  };
}

/**
 * Construct a LogDecoder backed by a real Anchor EventParser for the given IDL.
 *
 * Combines createAnchorEventParserLikeFromIdl with createAnchorEventParserDecoder
 * to produce a LogDecoder (name: "anchor_event_parser") that accepts raw Anchor
 * transaction log arrays and emits DecodedProgramEvent[].
 *
 * Decoded events feed unchanged into extractNoteDepositedEventsFromDecodedEvents
 * and the rest of the normalisation / sort / replay pipeline.
 */
export function createAnchorEventParserLogDecoderFromIdl(
  args: AnchorParserFactoryArgs
): LogDecoder {
  const parser = createAnchorEventParserLikeFromIdl(args);
  return createAnchorEventParserDecoder(parser);
}
