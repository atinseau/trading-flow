import { describe, expect, test } from "bun:test";
import { coerceSessionWindow } from "@workflows/replay/replaySessionWorkflow";

/**
 * Regression suite for the Date→string serialization gotcha that bit us
 * end-to-end : Temporal's default JSON converter strips Date semantics from
 * activity payloads, so by the time `loadReplaySession`'s result lands in
 * the workflow, `session.windowStartAt` is an ISO string — even though
 * `ReplaySession.windowStartAt: Date` claims otherwise.
 *
 * Pre-fix symptom (caught here as a hard runtime error pre-coercion) :
 *
 *     TypeError: session.windowStartAt.getTime is not a function
 *
 * These tests intentionally cover BOTH input shapes — a real `Date` (what
 * the persistence layer hands the activity) AND a `string` (what the
 * workflow actually sees after Temporal round-trips it). One or the other
 * regressing is enough to break replay end-to-end.
 */
describe("coerceSessionWindow", () => {
  const startIso = "2026-04-12T09:15:00.000Z";
  const endIso = "2026-04-15T09:15:00.000Z";
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();

  test("handles Date inputs (persistence-layer shape)", () => {
    const out = coerceSessionWindow({
      windowStartAt: new Date(startIso),
      windowEndAt: new Date(endIso),
    });
    expect(out.startMs).toBe(startMs);
    expect(out.endMs).toBe(endMs);
    expect(out.endDate).toBeInstanceOf(Date);
    expect(out.endDate.toISOString()).toBe(endIso);
  });

  test("handles ISO-string inputs (post-Temporal-serialization shape)", () => {
    // This is what actually lands in the workflow after Temporal JSON-
    // round-trips the activity result. Before the coercion fix, calling
    // `.getTime()` on these strings crashed the workflow at the first
    // signal — pendingWorkflowTask stayed Scheduled forever.
    const out = coerceSessionWindow({
      windowStartAt: startIso,
      windowEndAt: endIso,
    });
    expect(out.startMs).toBe(startMs);
    expect(out.endMs).toBe(endMs);
    expect(out.endDate).toBeInstanceOf(Date);
    expect(out.endDate.toISOString()).toBe(endIso);
  });

  test("handles a JSON-round-tripped session (faithful Temporal simulation)", () => {
    // The full payload that crosses the activity boundary in practice.
    // JSON.parse(JSON.stringify(...)) is exactly what Temporal's default
    // converter does to the activity return value.
    const session = {
      id: "test",
      watchId: "btcusdt-15m",
      status: "READY",
      windowStartAt: new Date(startIso),
      windowEndAt: new Date(endIso),
      costCapUsd: 5,
      costUsdSoFar: 0,
    };
    const serialized = JSON.parse(JSON.stringify(session)) as typeof session;
    // After round-trip, the Date fields are strings — verify our assumption
    // about Temporal's behavior before testing the coercion.
    expect(typeof serialized.windowStartAt).toBe("string");
    expect(typeof serialized.windowEndAt).toBe("string");

    const out = coerceSessionWindow(serialized);
    expect(out.startMs).toBe(startMs);
    expect(out.endMs).toBe(endMs);
  });

  test("throws on garbage inputs rather than yielding NaN", () => {
    expect(() =>
      coerceSessionWindow({
        windowStartAt: "not-a-date",
        windowEndAt: endIso,
      }),
    ).toThrow(/invalid window dates/);
    expect(() =>
      coerceSessionWindow({
        windowStartAt: startIso,
        windowEndAt: "also-bad",
      }),
    ).toThrow(/invalid window dates/);
  });
});
