import { describe, expect, test } from "bun:test";
import type { EventPayload } from "@domain/events/schemas";
import type { StoredReplayEvent } from "@domain/ports/ReplayEventStore";
import { projectSetupsFromEvents } from "@domain/replay/projectSetups";

const sessionId = "session-1";
const D = (iso: string) => new Date(iso);

function evt(overrides: Partial<StoredReplayEvent>): StoredReplayEvent {
  return {
    id: crypto.randomUUID(),
    sessionId,
    setupId: "setup-A",
    sequence: 1,
    occurredAt: D("2026-04-12T14:00:00.000Z"),
    stage: "detector",
    actor: "detector_v3",
    type: "DetectorTickProcessed",
    scoreDelta: 0,
    scoreAfter: null,
    statusBefore: null,
    statusAfter: null,
    payload: {
      type: "DetectorTickProcessed",
      data: { ignoreReason: "x" },
    } as EventPayload,
    provider: null,
    model: null,
    promptVersion: null,
    inputHash: null,
    latencyMs: null,
    cacheHit: false,
    ...overrides,
  };
}

describe("projectSetupsFromEvents", () => {
  test("empty input → []", () => {
    expect(projectSetupsFromEvents([])).toEqual([]);
  });

  test("events without setupId are ignored", () => {
    const out = projectSetupsFromEvents([
      evt({ setupId: null, type: "DetectorTickProcessed" }),
      evt({ setupId: null, type: "DetectorTickProcessed" }),
    ]);
    expect(out).toEqual([]);
  });

  test("SetupCreated only → CANDIDATE projection with key levels", () => {
    const out = projectSetupsFromEvents([
      evt({
        setupId: "A",
        sequence: 1,
        type: "SetupCreated",
        statusAfter: "REVIEWING",
        scoreAfter: 32,
        payload: {
          type: "SetupCreated",
          data: {
            pattern: "bos_reaction",
            direction: "LONG",
            keyLevels: { invalidation: 41950, entry: 42350, target: 42850 },
            initialScore: 32,
            rawObservation: "BOS bullish",
          },
        },
      }),
    ]);
    expect(out.length).toBe(1);
    const p = out[0]!;
    expect(p.setupId).toBe("A");
    expect(p.status).toBe("REVIEWING");
    expect(p.direction).toBe("LONG");
    expect(p.patternHint).toBe("bos_reaction");
    expect(p.currentScore).toBe(32);
    expect(p.entry).toBe(42350);
    expect(p.invalidationLevel).toBe(41950);
    expect(p.stopLoss).toBeNull();
    expect(p.takeProfit).toBeNull();
    expect(p.outcome).toBeNull();
    expect(p.rMultiple).toBeNull();
  });

  test("Confirmed event populates entry/SL/TP and status", () => {
    const out = projectSetupsFromEvents([
      evt({
        setupId: "A",
        sequence: 1,
        type: "SetupCreated",
        statusAfter: "REVIEWING",
        scoreAfter: 32,
        payload: {
          type: "SetupCreated",
          data: {
            pattern: "bos",
            direction: "LONG",
            keyLevels: { invalidation: 100, entry: 105 },
            initialScore: 32,
            rawObservation: "",
          },
        },
      }),
      evt({
        setupId: "A",
        sequence: 2,
        type: "Confirmed",
        statusAfter: "TRACKING",
        scoreAfter: 83,
        payload: {
          type: "Confirmed",
          data: {
            decision: "GO",
            entry: 105,
            stopLoss: 100,
            takeProfit: [110, 115],
            reasoning: "...",
          },
        },
      }),
    ]);
    const p = out[0]!;
    expect(p.entry).toBe(105);
    expect(p.stopLoss).toBe(100);
    expect(p.takeProfit).toEqual([110, 115]);
    expect(p.status).toBe("TRACKING");
    expect(p.currentScore).toBe(83);
  });

  test("Confirmed + EntryFilled + TPHit → CLOSED, WIN, rMultiple > 0", () => {
    const filled: EventPayload = {
      type: "EntryFilled",
      data: { fillPrice: 100, observedAt: D("2026-04-12T15:00:00.000Z").toISOString() },
    };
    const out = projectSetupsFromEvents([
      evt({
        setupId: "A",
        sequence: 1,
        type: "SetupCreated",
        statusAfter: "REVIEWING",
        scoreAfter: 32,
        payload: {
          type: "SetupCreated",
          data: {
            pattern: "bos",
            direction: "LONG",
            keyLevels: { invalidation: 90, entry: 100 },
            initialScore: 32,
            rawObservation: "",
          },
        },
      }),
      evt({
        setupId: "A",
        sequence: 2,
        type: "Confirmed",
        statusAfter: "TRACKING",
        scoreAfter: 83,
        payload: {
          type: "Confirmed",
          data: { decision: "GO", entry: 100, stopLoss: 90, takeProfit: [110], reasoning: "..." },
        },
      }),
      evt({
        setupId: "A",
        sequence: 3,
        type: "EntryFilled",
        statusAfter: "TRACKING",
        payload: filled,
      }),
      evt({
        setupId: "A",
        sequence: 4,
        type: "TPHit",
        statusAfter: "CLOSED",
        occurredAt: D("2026-04-12T16:00:00.000Z"),
        payload: {
          type: "TPHit",
          data: { level: 110, index: 0, observedAt: D("2026-04-12T16:00:00.000Z").toISOString() },
        },
      }),
    ]);
    const p = out[0]!;
    expect(p.status).toBe("CLOSED");
    expect(p.outcome).toBe("WIN");
    expect(p.rMultiple).toBeCloseTo(1.0, 5);
    expect(p.closedAt?.toISOString()).toBe("2026-04-12T16:00:00.000Z");
  });

  test("multi-setup events produce one projection per setup", () => {
    const out = projectSetupsFromEvents([
      evt({ setupId: "A", sequence: 1, type: "SetupCreated" }),
      evt({ setupId: "B", sequence: 1, type: "SetupCreated" }),
      evt({ setupId: "A", sequence: 2, type: "DetectorTickProcessed" }),
    ]);
    expect(out.length).toBe(2);
    const ids = out.map((p) => p.setupId).sort();
    expect(ids).toEqual(["A", "B"]);
  });

  test("projections ordered by lastEventAt desc", () => {
    const out = projectSetupsFromEvents([
      evt({
        setupId: "OLD",
        sequence: 1,
        type: "SetupCreated",
        occurredAt: D("2026-04-10T12:00:00.000Z"),
      }),
      evt({
        setupId: "NEW",
        sequence: 1,
        type: "SetupCreated",
        occurredAt: D("2026-04-12T18:00:00.000Z"),
      }),
    ]);
    expect(out.map((p) => p.setupId)).toEqual(["NEW", "OLD"]);
  });
});
