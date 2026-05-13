import { describe, expect, test } from "bun:test";
import {
  derivePlayheadAt,
  findLastEventAtInWindow,
  type PlayheadEvent,
} from "@client/components/replay/derivePlayheadAt";

/**
 * Unit suite for the playhead derivation that lives in
 * `src/client/components/replay/derivePlayheadAt.ts`. The component using
 * this helper (`replay-session.tsx`) previously had the logic inlined and
 * defaulted to `windowEndAt` — a regression that froze every fresh session
 * at COMPLETED after a single Step. These tests pin the contract down.
 */

const windowStartAt = new Date("2026-04-12T09:15:00.000Z");
const windowEndAt = new Date("2026-04-15T09:15:00.000Z");

function evt(iso: string): PlayheadEvent {
  return { occurredAt: iso };
}

describe("findLastEventAtInWindow", () => {
  test("returns null for an empty event list", () => {
    expect(findLastEventAtInWindow([], windowStartAt, windowEndAt)).toBeNull();
  });

  test("returns the latest event timestamp when all events are inside the window", () => {
    const events = [
      evt("2026-04-12T10:00:00.000Z"),
      evt("2026-04-13T08:00:00.000Z"),
      evt("2026-04-12T15:00:00.000Z"),
    ];
    const out = findLastEventAtInWindow(events, windowStartAt, windowEndAt);
    expect(out?.toISOString()).toBe("2026-04-13T08:00:00.000Z");
  });

  test("ignores events landing OUTSIDE the window (ReplayMeta wall-clock case)", () => {
    // Realistic case : a `ReplayMeta(paused)` event timestamped with the
    // user's current wall-clock — months after the historical window.
    // Without the clamp, this would yank the playhead off the chart.
    const events = [
      evt("2026-04-12T10:00:00.000Z"), // valid
      evt("2026-04-14T09:00:00.000Z"), // valid, latest in-window
      evt("2026-05-13T11:30:00.000Z"), // wall-clock pause, OUTSIDE window
    ];
    const out = findLastEventAtInWindow(events, windowStartAt, windowEndAt);
    expect(out?.toISOString()).toBe("2026-04-14T09:00:00.000Z");
  });

  test("accepts events exactly at the window boundaries (inclusive)", () => {
    const events = [evt(windowStartAt.toISOString()), evt(windowEndAt.toISOString())];
    const out = findLastEventAtInWindow(events, windowStartAt, windowEndAt);
    expect(out?.toISOString()).toBe(windowEndAt.toISOString());
  });

  test("returns null when every event is outside the window", () => {
    const events = [evt("2025-01-01T00:00:00.000Z"), evt("2026-12-31T23:59:59.000Z")];
    expect(findLastEventAtInWindow(events, windowStartAt, windowEndAt)).toBeNull();
  });

  test("silently drops malformed occurredAt strings", () => {
    const events = [evt("not-a-date"), evt("2026-04-13T08:00:00.000Z")];
    const out = findLastEventAtInWindow(events, windowStartAt, windowEndAt);
    expect(out?.toISOString()).toBe("2026-04-13T08:00:00.000Z");
  });
});

describe("derivePlayheadAt", () => {
  test("defaults to windowStartAt when no events and no scrub — NEVER windowEndAt", () => {
    // This is the regression we're protecting against. A return value of
    // `windowEndAt` here means every Step batches `[windowEndAt]` and the
    // workflow auto-completes the session after one click.
    const out = derivePlayheadAt({
      windowStartAt,
      windowEndAt,
      events: [],
      scrubMs: null,
    });
    expect(out.toISOString()).toBe(windowStartAt.toISOString());
    expect(out.getTime()).not.toBe(windowEndAt.getTime());
  });

  test("returns latest in-window event when events exist and no scrub", () => {
    const out = derivePlayheadAt({
      windowStartAt,
      windowEndAt,
      events: [evt("2026-04-13T08:00:00.000Z"), evt("2026-04-12T10:00:00.000Z")],
      scrubMs: null,
    });
    expect(out.toISOString()).toBe("2026-04-13T08:00:00.000Z");
  });

  test("user scrub overrides everything (including a later event)", () => {
    const scrubMs = new Date("2026-04-12T12:00:00.000Z").getTime();
    const out = derivePlayheadAt({
      windowStartAt,
      windowEndAt,
      events: [evt("2026-04-14T08:00:00.000Z")], // later than the scrub
      scrubMs,
    });
    expect(out.getTime()).toBe(scrubMs);
  });

  test("user scrub of 0 (epoch) is honored — does not collapse to fallback", () => {
    // Guards against `if (scrubMs)` truthiness bugs : 0 must be respected.
    const out = derivePlayheadAt({
      windowStartAt,
      windowEndAt,
      events: [evt("2026-04-14T08:00:00.000Z")],
      scrubMs: 0,
    });
    expect(out.getTime()).toBe(0);
  });

  test("falls back to windowStartAt when all events are outside the window", () => {
    const out = derivePlayheadAt({
      windowStartAt,
      windowEndAt,
      events: [evt("2026-05-13T11:30:00.000Z")], // pause meta, outside
      scrubMs: null,
    });
    expect(out.toISOString()).toBe(windowStartAt.toISOString());
  });
});
