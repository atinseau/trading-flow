import { describe, expect, test } from "bun:test";
import {
  buildReplayFeedbackContext,
  deriveSetupTimeline,
  formatSetupEventsMarkdown,
} from "@domain/replay/feedbackContext";
import type { StoredReplayEvent } from "@domain/ports/ReplayEventStore";
import { FakeChartRenderer } from "@test-fakes/FakeChartRenderer";
import { FakeMarketDataFetcher } from "@test-fakes/FakeMarketDataFetcher";
import { InMemoryArtifactStore } from "@test-fakes/InMemoryArtifactStore";

const setupId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function evt(args: {
  seq: number;
  type: StoredReplayEvent["type"];
  occurredAt: string;
  scoreAfter?: number | null;
  scoreDelta?: number;
  statusBefore?: string | null;
  statusAfter?: string | null;
  data?: Record<string, unknown>;
}): StoredReplayEvent {
  return {
    id: `evt-${args.seq}`,
    sessionId,
    sequence: args.seq,
    setupId,
    occurredAt: new Date(args.occurredAt),
    stage: "system",
    actor: "test",
    type: args.type,
    scoreDelta: args.scoreDelta ?? 0,
    scoreAfter: args.scoreAfter ?? 0,
    statusBefore: args.statusBefore ?? null,
    statusAfter: args.statusAfter ?? null,
    payload: { type: args.type as never, data: (args.data ?? {}) as never },
    provider: null,
    model: null,
    promptVersion: null,
    inputHash: null,
    latencyMs: null,
    cacheHit: false,
  };
}

describe("deriveSetupTimeline", () => {
  test("extracts SetupCreated / Confirmed / terminal occurredAt", () => {
    const events: StoredReplayEvent[] = [
      evt({ seq: 1, type: "SetupCreated", occurredAt: "2026-05-10T10:00:00Z" }),
      evt({ seq: 2, type: "Strengthened", occurredAt: "2026-05-10T11:00:00Z" }),
      evt({ seq: 3, type: "Confirmed", occurredAt: "2026-05-10T12:00:00Z" }),
      evt({ seq: 4, type: "TPHit", occurredAt: "2026-05-10T14:00:00Z" }),
    ];
    const { setupCreatedAt, confirmedAt, setupClosedAt } = deriveSetupTimeline(events);
    expect(setupCreatedAt?.toISOString()).toBe("2026-05-10T10:00:00.000Z");
    expect(confirmedAt?.toISOString()).toBe("2026-05-10T12:00:00.000Z");
    expect(setupClosedAt?.toISOString()).toBe("2026-05-10T14:00:00.000Z");
  });

  test("never-confirmed setup: confirmedAt stays null, but setupClosedAt can be set", () => {
    const events: StoredReplayEvent[] = [
      evt({ seq: 1, type: "SetupCreated", occurredAt: "2026-05-10T10:00:00Z" }),
      evt({ seq: 2, type: "Rejected", occurredAt: "2026-05-10T12:00:00Z" }),
    ];
    const { setupCreatedAt, confirmedAt, setupClosedAt } = deriveSetupTimeline(events);
    expect(setupCreatedAt).not.toBeNull();
    expect(confirmedAt).toBeNull();
    expect(setupClosedAt?.toISOString()).toBe("2026-05-10T12:00:00.000Z");
  });

  test("empty events: all timestamps null", () => {
    const { setupCreatedAt, confirmedAt, setupClosedAt } = deriveSetupTimeline([]);
    expect(setupCreatedAt).toBeNull();
    expect(confirmedAt).toBeNull();
    expect(setupClosedAt).toBeNull();
  });
});

describe("formatSetupEventsMarkdown", () => {
  test("renders score transitions, status, and embedded reasoning", () => {
    const events: StoredReplayEvent[] = [
      evt({
        seq: 1,
        type: "SetupCreated",
        occurredAt: "2026-05-10T10:00:00Z",
        scoreDelta: 60,
        scoreAfter: 60,
        statusBefore: null,
        statusAfter: "REVIEWING",
        data: { pattern: "bullish_engulfing" },
      }),
      evt({
        seq: 2,
        type: "Strengthened",
        occurredAt: "2026-05-10T11:00:00Z",
        scoreDelta: 10,
        scoreAfter: 70,
        statusBefore: "REVIEWING",
        statusAfter: "REVIEWING",
        data: {
          reasoning: "Volume confirms breakout",
          observations: [{ kind: "trend", text: "uptrend" }],
        },
      }),
    ];
    const md = formatSetupEventsMarkdown(events);
    expect(md).toContain("Setup timeline (2 events)");
    expect(md).toContain("Tick 1 — SetupCreated");
    expect(md).toContain("score: 0 → 60");
    expect(md).toContain("pattern: bullish_engulfing");
    expect(md).toContain("reasoning: Volume confirms breakout");
    expect(md).toContain("**trend**: uptrend");
  });
});

describe("buildReplayFeedbackContext", () => {
  function setupDeps() {
    const fetcher = new FakeMarketDataFetcher();
    fetcher.seed("BTCUSDT", "1h", FakeMarketDataFetcher.generateLinear(200, 30_000));
    return {
      marketDataFetcher: fetcher,
      chartRenderer: new FakeChartRenderer(),
      artifactStore: new InMemoryArtifactStore(),
    };
  }

  test("confirmed-then-closed setup produces 3 chunks", async () => {
    const events: StoredReplayEvent[] = [
      evt({ seq: 1, type: "SetupCreated", occurredAt: "2026-05-10T10:00:00Z" }),
      evt({ seq: 2, type: "Confirmed", occurredAt: "2026-05-10T12:00:00Z" }),
      evt({ seq: 3, type: "SLHit", occurredAt: "2026-05-10T14:00:00Z" }),
    ];
    const deps = setupDeps();
    const chunks = await buildReplayFeedbackContext(deps, {
      asset: "BTCUSDT",
      timeframe: "1h",
      setupEvents: events,
    });
    const ids = chunks.map((c) => c.providerId).sort();
    expect(ids).toEqual(["chart-post-mortem", "post-mortem-ohlcv", "setup-events"]);
  });

  test("never-confirmed setup produces only the setup-events chunk", async () => {
    const events: StoredReplayEvent[] = [
      evt({ seq: 1, type: "SetupCreated", occurredAt: "2026-05-10T10:00:00Z" }),
      evt({ seq: 2, type: "Rejected", occurredAt: "2026-05-10T12:00:00Z" }),
    ];
    const deps = setupDeps();
    const chunks = await buildReplayFeedbackContext(deps, {
      asset: "BTCUSDT",
      timeframe: "1h",
      setupEvents: events,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.providerId).toBe("setup-events");
  });
});
