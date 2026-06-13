// Pure/local Anchor-style event fixture parser for NoteDeposited events.
//
// No network, no RPC, no validator. Parses pre-fetched or locally constructed
// fixture data only.
//
// Two input modes:
//   Mode A — Anchor EventParser-like:  fixture.events[].{name, data}
//   Mode B — local log lines:           fixture.logs[] with EVENT_JSON: marker
//
// Both modes normalise through normalizeNoteDepositedEvent so all validation
// rules are shared with the live ingestion path.

import {
  NormalizedNoteDepositedEvent,
  normalizeNoteDepositedEvent,
} from "./event_log";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedAnchorEventLike {
  name: string;
  data: unknown;
}

export interface TransactionEventFixture {
  signature?: string;
  slot?: bigint | number | string;
  events?: ParsedAnchorEventLike[];
  logs?: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EVENT_JSON_MARKER = "EVENT_JSON:";
const NOTE_DEPOSITED_NAMES = new Set(["noteDeposited", "NoteDeposited"]);

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Merge event data with fixture-level fallbacks before normalisation.
 * Only injects a fallback when the corresponding key is absent from eventData.
 */
function buildRawForNormalization(
  eventData: unknown,
  fixtureSignature?: string,
  fixtureSlot?: bigint | number | string,
  logIndex?: number
): unknown {
  if (eventData === null || typeof eventData !== "object") {
    // Let normalizeNoteDepositedEvent reject non-objects with a clear message.
    return eventData;
  }

  const base = { ...(eventData as Record<string, unknown>) };

  if (base["slot"] === undefined && fixtureSlot !== undefined) {
    base["slot"] = fixtureSlot;
  }
  if (base["signature"] === undefined && fixtureSignature !== undefined) {
    base["signature"] = fixtureSignature;
  }
  if (logIndex !== undefined && base["log_index"] === undefined) {
    base["log_index"] = logIndex;
  }

  return base;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a single log line for an EVENT_JSON-marked event object.
 *
 * Returns null if the line does not contain the EVENT_JSON: marker.
 * Throws on malformed JSON after the marker, or if the parsed object lacks a
 * string 'name' field or a 'data' field.
 */
export function parseEventJsonLogLine(
  line: string
): ParsedAnchorEventLike | null {
  const markerIdx = line.indexOf(EVENT_JSON_MARKER);
  if (markerIdx === -1) return null;

  const jsonStr = line.slice(markerIdx + EVENT_JSON_MARKER.length);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(
      `parseEventJsonLogLine: malformed JSON after EVENT_JSON: marker: ${
        (err as Error).message
      }`
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      "parseEventJsonLogLine: EVENT_JSON value must be a JSON object"
    );
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj["name"] !== "string") {
    throw new Error(
      "parseEventJsonLogLine: EVENT_JSON object missing string 'name' field"
    );
  }

  if (!("data" in obj)) {
    throw new Error(
      "parseEventJsonLogLine: EVENT_JSON object missing 'data' field"
    );
  }

  return { name: obj["name"] as string, data: obj["data"] };
}

/**
 * Extract and normalise NoteDeposited events from a single transaction fixture.
 *
 * Processes fixture.events (Mode A) in order, then fixture.logs (Mode B) in
 * order.  Events with names other than "noteDeposited" / "NoteDeposited" are
 * silently ignored.
 *
 * Fixture-level signature and slot are injected as fallbacks when the event
 * data itself does not provide those fields.  For log-sourced events, the log
 * line index is attached as log_index fallback.
 *
 * Throws with contextual source information on malformed event data.
 */
export function extractNoteDepositedEventsFromFixture(
  fixture: TransactionEventFixture
): NormalizedNoteDepositedEvent[] {
  const results: NormalizedNoteDepositedEvent[] = [];

  // Mode A: EventParser-like events array
  if (fixture.events) {
    for (let i = 0; i < fixture.events.length; i++) {
      const ev = fixture.events[i];
      if (!NOTE_DEPOSITED_NAMES.has(ev.name)) continue;

      const raw = buildRawForNormalization(
        ev.data,
        fixture.signature,
        fixture.slot
      );

      let normalized: NormalizedNoteDepositedEvent;
      try {
        normalized = normalizeNoteDepositedEvent(raw);
      } catch (err) {
        throw new Error(
          `extractNoteDepositedEventsFromFixture: malformed event data in events[${i}]: ${
            (err as Error).message
          }`
        );
      }

      results.push(normalized);
    }
  }

  // Mode B: raw log lines with EVENT_JSON: marker
  if (fixture.logs) {
    for (let i = 0; i < fixture.logs.length; i++) {
      const parsed = parseEventJsonLogLine(fixture.logs[i]);
      if (parsed === null) continue;
      if (!NOTE_DEPOSITED_NAMES.has(parsed.name)) continue;

      const raw = buildRawForNormalization(
        parsed.data,
        fixture.signature,
        fixture.slot,
        i
      );

      let normalized: NormalizedNoteDepositedEvent;
      try {
        normalized = normalizeNoteDepositedEvent(raw);
      } catch (err) {
        throw new Error(
          `extractNoteDepositedEventsFromFixture: malformed event data in logs[${i}]: ${
            (err as Error).message
          }`
        );
      }

      results.push(normalized);
    }
  }

  return results;
}

/**
 * Extract and normalise NoteDeposited events from multiple transaction fixtures.
 *
 * Flattens results across fixtures in input order.  Does not sort, replay, or
 * save snapshots — this is extraction only.
 */
export function extractNoteDepositedEventsFromFixtures(
  fixtures: TransactionEventFixture[]
): NormalizedNoteDepositedEvent[] {
  const results: NormalizedNoteDepositedEvent[] = [];
  for (const fixture of fixtures) {
    for (const ev of extractNoteDepositedEventsFromFixture(fixture)) {
      results.push(ev);
    }
  }
  return results;
}
