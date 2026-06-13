// Local event decoder boundary for the ZK indexer.
//
// Defines a DecodedProgramEvent intermediate representation and decoders that
// convert raw log arrays or pre-parsed fixture objects into that form. The
// output feeds unchanged into the existing normalizeNoteDepositedEvent / sort /
// replay / snapshot pipeline.
//
// No network, no RPC, no validator. No @solana/web3.js imports.
// Three decoder modes:
//   EventJsonLogDecoder           — "event_json_log" source
//   decodeEventParserLikeFixture  — "event_parser_like_fixture" source (helper)
//   createAnchorEventParserDecoder — "anchor_event_parser" source (DI wrapper)
//
// Real Anchor base64 EventParser integration is intentionally deferred. The
// AnchorEventParserLike interface and createAnchorEventParserDecoder provide the
// integration point; callers supply a concrete parser via dependency injection.
// No @coral-xyz/anchor or @solana/web3.js is imported at the module level.

import {
  NormalizedNoteDepositedEvent,
  normalizeNoteDepositedEvent,
} from "./event_log";
import { parseEventJsonLogLine } from "./log_parser";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DecodedEventSource =
  | "event_json_log"
  | "anchor_event_parser"
  | "event_parser_like_fixture";

export interface DecodedProgramEvent {
  name: string;
  data: unknown;
  source: DecodedEventSource;
  signature?: string;
  slot?: bigint | number | string;
  log_index?: number;
}

export interface LogDecoder {
  readonly name: string;
  decodeLogs(args: {
    logs: string[];
    signature?: string;
    slot?: bigint | number | string;
  }): DecodedProgramEvent[];
}

// Dependency-injection interface for a real Anchor EventParser.
// Real Anchor base64 EventParser integration is intentionally deferred; supply
// a concrete implementation when ready. Tests use fake parser objects only.
export interface AnchorEventParserLike {
  parseLogs(logs: string[]): Iterable<{ name: string; data: unknown }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const NOTE_DEPOSITED_NAMES = new Set(["noteDeposited", "NoteDeposited"]);

// ── EventJsonLogDecoder ───────────────────────────────────────────────────────

export class EventJsonLogDecoder implements LogDecoder {
  readonly name = "event_json_log";

  decodeLogs({
    logs,
    signature,
    slot,
  }: {
    logs: string[];
    signature?: string;
    slot?: bigint | number | string;
  }): DecodedProgramEvent[] {
    const results: DecodedProgramEvent[] = [];

    for (let i = 0; i < logs.length; i++) {
      let parsed: ReturnType<typeof parseEventJsonLogLine>;
      try {
        parsed = parseEventJsonLogLine(logs[i]);
      } catch (err) {
        throw new Error(
          `EventJsonLogDecoder: malformed EVENT_JSON at log index ${i}: ${
            (err as Error).message
          }`
        );
      }
      if (parsed === null) continue;

      // Resolve metadata: event data takes priority over caller-supplied fallbacks.
      const dataObj =
        parsed.data !== null && typeof parsed.data === "object"
          ? (parsed.data as Record<string, unknown>)
          : undefined;

      const resolvedSig =
        dataObj !== undefined && dataObj["signature"] !== undefined
          ? String(dataObj["signature"])
          : signature;

      const resolvedSlot =
        dataObj !== undefined && dataObj["slot"] !== undefined
          ? (dataObj["slot"] as bigint | number | string)
          : slot;

      const resolvedLogIndex =
        dataObj !== undefined && dataObj["log_index"] !== undefined
          ? Number(dataObj["log_index"])
          : i;

      const event: DecodedProgramEvent = {
        name: parsed.name,
        data: parsed.data,
        source: "event_json_log",
        log_index: resolvedLogIndex,
      };
      if (resolvedSig !== undefined) event.signature = resolvedSig;
      if (resolvedSlot !== undefined) event.slot = resolvedSlot;

      results.push(event);
    }

    return results;
  }
}

// ── EventParser-like fixture helper ──────────────────────────────────────────

/**
 * Convert already-decoded { name, data }[] objects (e.g. from the Anchor
 * EventParser or from test fixtures) into DecodedProgramEvent[].
 *
 * This is a helper rather than a LogDecoder because it accepts pre-parsed
 * events, not raw log strings. The resulting source is "event_parser_like_fixture".
 */
export function decodeEventParserLikeFixture(
  events: { name: string; data: unknown }[],
  args?: { signature?: string; slot?: bigint | number | string }
): DecodedProgramEvent[] {
  return events.map((ev) => {
    const event: DecodedProgramEvent = {
      name: ev.name,
      data: ev.data,
      source: "event_parser_like_fixture",
    };
    if (args?.signature !== undefined) event.signature = args.signature;
    if (args?.slot !== undefined) event.slot = args.slot;
    return event;
  });
}

// ── AnchorEventParser dependency-injection wrapper ────────────────────────────

/**
 * Wrap an AnchorEventParserLike as a LogDecoder.
 *
 * The supplied parser is responsible for decoding raw log lines (e.g. base64
 * Anchor events). This wrapper adapts the parser's output into DecodedProgramEvent[]
 * without importing @coral-xyz/anchor or @solana/web3.js at the module level.
 *
 * Real Anchor EventParser integration is intentionally deferred. Tests use a
 * fake AnchorEventParserLike object. No live RPC or real parser is needed here.
 */
export function createAnchorEventParserDecoder(
  parser: AnchorEventParserLike
): LogDecoder {
  return {
    name: "anchor_event_parser",
    decodeLogs({ logs, signature, slot }) {
      const results: DecodedProgramEvent[] = [];
      let index = 0;
      for (const ev of parser.parseLogs(logs)) {
        const event: DecodedProgramEvent = {
          name: ev.name,
          data: ev.data,
          source: "anchor_event_parser",
          log_index: index,
        };
        if (signature !== undefined) event.signature = signature;
        if (slot !== undefined) event.slot = slot;
        results.push(event);
        index++;
      }
      return results;
    },
  };
}

// ── Normalization helpers ─────────────────────────────────────────────────────

/**
 * Merge a DecodedProgramEvent's metadata fallbacks into a copy of its data
 * object. Only injects signature, slot, and log_index when the data does not
 * already provide those fields.
 *
 * The returned object can be passed directly to normalizeNoteDepositedEvent.
 * Throws if event.data is not a non-null object.
 */
export function decodedProgramEventToRawNoteEvent(
  event: DecodedProgramEvent
): unknown {
  if (event.data === null || typeof event.data !== "object") {
    throw new Error(
      "decodedProgramEventToRawNoteEvent: event data must be an object"
    );
  }

  const base = { ...(event.data as Record<string, unknown>) };

  if (base["signature"] === undefined && event.signature !== undefined) {
    base["signature"] = event.signature;
  }
  if (base["slot"] === undefined && event.slot !== undefined) {
    base["slot"] = event.slot;
  }
  if (base["log_index"] === undefined && event.log_index !== undefined) {
    base["log_index"] = event.log_index;
  }

  return base;
}

/**
 * Extract and normalise NoteDeposited events from an array of DecodedProgramEvents.
 *
 * Filters by name ("noteDeposited" / "NoteDeposited"), converts each matching
 * event via decodedProgramEventToRawNoteEvent, and normalises via
 * normalizeNoteDepositedEvent. Preserves input order. Does not sort, replay,
 * or save snapshots.
 *
 * Throws with contextual index and source on malformed event data.
 */
export function extractNoteDepositedEventsFromDecodedEvents(
  events: DecodedProgramEvent[]
): NormalizedNoteDepositedEvent[] {
  const results: NormalizedNoteDepositedEvent[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!NOTE_DEPOSITED_NAMES.has(event.name)) continue;

    let raw: unknown;
    try {
      raw = decodedProgramEventToRawNoteEvent(event);
    } catch (err) {
      throw new Error(
        `extractNoteDepositedEventsFromDecodedEvents: event at index ${i} (source: ${
          event.source
        }): ${(err as Error).message}`
      );
    }

    let normalized: NormalizedNoteDepositedEvent;
    try {
      normalized = normalizeNoteDepositedEvent(raw);
    } catch (err) {
      throw new Error(
        `extractNoteDepositedEventsFromDecodedEvents: event at index ${i} (source: ${
          event.source
        }): ${(err as Error).message}`
      );
    }

    results.push(normalized);
  }

  return results;
}

// ── Convenience functions ─────────────────────────────────────────────────────

/**
 * Decode EVENT_JSON-marked log lines into DecodedProgramEvents.
 * Convenience wrapper around EventJsonLogDecoder.
 */
export function decodeEventJsonLogs(args: {
  logs: string[];
  signature?: string;
  slot?: bigint | number | string;
}): DecodedProgramEvent[] {
  return new EventJsonLogDecoder().decodeLogs(args);
}

/**
 * Full single-call path: decode EVENT_JSON logs and extract NoteDeposited events.
 * Does not sort, replay, or save snapshots.
 */
export function extractNoteDepositedEventsFromEventJsonLogs(args: {
  logs: string[];
  signature?: string;
  slot?: bigint | number | string;
}): NormalizedNoteDepositedEvent[] {
  return extractNoteDepositedEventsFromDecodedEvents(decodeEventJsonLogs(args));
}
