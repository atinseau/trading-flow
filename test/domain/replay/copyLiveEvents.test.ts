import { beforeEach, describe, expect, test } from "bun:test";
import type { LiveEventInWindow } from "@domain/ports/LiveEventQueryByWindow";
import { copyLiveEventsToReplay } from "@domain/replay/copyLiveEvents";
import { InMemoryLiveEventQueryByWindow } from "../../fakes/InMemoryLiveEventQueryByWindow";
import { InMemoryReplayEventStore } from "../../fakes/InMemoryReplayEventStore";

const D = (iso: string) => new Date(iso);

function mkLive(overrides: Partial<LiveEventInWindow> = {}): LiveEventInWindow {
  return {
    setupId: crypto.randomUUID(),
    watchId: "btc-1h",
    occurredAt: D("2026-04-12T15:00:00.000Z"),
    sequence: 1,
    stage: "detector",
    actor: "detector_v3",
    type: "SetupCreated",
    scoreDelta: 32,
    scoreAfter: 32,
    statusBefore: "CANDIDATE",
    statusAfter: "REVIEWING",
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
    provider: "claude_max",
    model: "claude-sonnet-4-6",
    promptVersion: "detector_v3",
    inputHash: "abc",
    latencyMs: 4200,
    ...overrides,
  };
}

let liveQuery: InMemoryLiveEventQueryByWindow;
let replayStore: InMemoryReplayEventStore;
const sessionId = "session-uuid";

beforeEach(() => {
  liveQuery = new InMemoryLiveEventQueryByWindow();
  replayStore = new InMemoryReplayEventStore();
});

describe("copyLiveEventsToReplay", () => {
  test("no setups in window → 0 copied", async () => {
    const out = await copyLiveEventsToReplay(
      { liveEventQuery: liveQuery, replayEventStore: replayStore },
      {
        sessionId,
        watchId: "btc-1h",
        windowStartAt: D("2026-04-12T14:00:00.000Z"),
        windowEndAt: D("2026-04-13T14:00:00.000Z"),
      },
    );
    expect(out.copied).toBe(0);
    expect(await replayStore.countBySession(sessionId)).toBe(0);
  });

  test("5 events in window → 5 copied with monotonic replay sequence", async () => {
    const setupA = crypto.randomUUID();
    for (let i = 0; i < 5; i++) {
      liveQuery.events.push(
        mkLive({
          setupId: setupA,
          sequence: i + 1,
          occurredAt: D(`2026-04-12T${String(14 + i).padStart(2, "0")}:00:00.000Z`),
        }),
      );
    }
    const out = await copyLiveEventsToReplay(
      { liveEventQuery: liveQuery, replayEventStore: replayStore },
      {
        sessionId,
        watchId: "btc-1h",
        windowStartAt: D("2026-04-12T14:00:00.000Z"),
        windowEndAt: D("2026-04-13T14:00:00.000Z"),
      },
    );
    expect(out.copied).toBe(5);
    const inReplay = await replayStore.listBySession(sessionId);
    expect(inReplay.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    // setupId preserved
    expect(inReplay.every((e) => e.setupId === setupA)).toBe(true);
  });

  test("two setups in window → both copied, interleaved by occurredAt", async () => {
    const setupA = crypto.randomUUID();
    const setupB = crypto.randomUUID();
    liveQuery.events.push(
      mkLive({ setupId: setupA, occurredAt: D("2026-04-12T14:00:00.000Z") }),
      mkLive({ setupId: setupB, occurredAt: D("2026-04-12T15:00:00.000Z") }),
      mkLive({ setupId: setupA, occurredAt: D("2026-04-12T16:00:00.000Z") }),
      mkLive({ setupId: setupB, occurredAt: D("2026-04-12T17:00:00.000Z") }),
    );
    const out = await copyLiveEventsToReplay(
      { liveEventQuery: liveQuery, replayEventStore: replayStore },
      {
        sessionId,
        watchId: "btc-1h",
        windowStartAt: D("2026-04-12T14:00:00.000Z"),
        windowEndAt: D("2026-04-13T14:00:00.000Z"),
      },
    );
    expect(out.copied).toBe(4);
    const inReplay = await replayStore.listBySession(sessionId);
    expect(inReplay.map((e) => e.setupId)).toEqual([setupA, setupB, setupA, setupB]);
  });

  test("events outside window are not copied", async () => {
    const setupId = crypto.randomUUID();
    liveQuery.events.push(
      mkLive({ setupId, occurredAt: D("2026-04-10T12:00:00.000Z") }), // before
      mkLive({ setupId, occurredAt: D("2026-04-12T15:00:00.000Z") }), // in
      mkLive({ setupId, occurredAt: D("2026-04-15T08:00:00.000Z") }), // after
    );
    const out = await copyLiveEventsToReplay(
      { liveEventQuery: liveQuery, replayEventStore: replayStore },
      {
        sessionId,
        watchId: "btc-1h",
        windowStartAt: D("2026-04-12T14:00:00.000Z"),
        windowEndAt: D("2026-04-13T14:00:00.000Z"),
      },
    );
    expect(out.copied).toBe(1);
  });

  test("events from other watches are excluded", async () => {
    liveQuery.events.push(
      mkLive({ watchId: "btc-1h", occurredAt: D("2026-04-12T15:00:00.000Z") }),
      mkLive({ watchId: "eth-4h", occurredAt: D("2026-04-12T15:00:00.000Z") }),
    );
    const out = await copyLiveEventsToReplay(
      { liveEventQuery: liveQuery, replayEventStore: replayStore },
      {
        sessionId,
        watchId: "btc-1h",
        windowStartAt: D("2026-04-12T14:00:00.000Z"),
        windowEndAt: D("2026-04-13T14:00:00.000Z"),
      },
    );
    expect(out.copied).toBe(1);
    const inReplay = await replayStore.listBySession(sessionId);
    expect(inReplay[0]?.payload).toBeDefined();
  });
});
