import { beforeEach, describe, expect, test } from "bun:test";
import { makeReplayApi, type ReplayApiDeps } from "@client/api/replay";
import type { WatchRepository, WatchValidationResult } from "@domain/ports/WatchRepository";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { FakeClock } from "../../fakes/FakeClock";
import { FakeMarketDataFetcher } from "../../fakes/FakeMarketDataFetcher";
import { InMemoryLiveEventQueryByWindow } from "../../fakes/InMemoryLiveEventQueryByWindow";
import { InMemoryLLMResponseCacheStore } from "../../fakes/InMemoryLLMResponseCacheStore";
import { InMemoryReplayEventStore } from "../../fakes/InMemoryReplayEventStore";
import { InMemoryReplayLLMCallStore } from "../../fakes/InMemoryReplayLLMCallStore";
import { InMemoryReplaySessionRepository } from "../../fakes/InMemoryReplaySessionRepository";

class FakeWatchRepository implements WatchRepository {
  private watches = new Map<string, WatchConfig>();

  add(id: string, config: WatchConfig): void {
    this.watches.set(id, config);
  }

  async findAll(): Promise<WatchConfig[]> {
    return [...this.watches.values()];
  }
  async findEnabled(): Promise<WatchConfig[]> {
    return [...this.watches.values()];
  }
  async findById(id: string): Promise<WatchConfig | null> {
    return this.watches.get(id) ?? null;
  }
  async findAllWithValidation(): Promise<WatchValidationResult[]> {
    return [];
  }
}

const minimalConfig = {
  id: "btc-1h",
  asset: { symbol: "BTCUSDT", source: "fake" },
  timeframes: { primary: "1h", higher: [] },
  candles: { detector_lookback: 200, reviewer_chart_window: 60 },
} as unknown as WatchConfig;

let deps: ReplayApiDeps;
let watchRepo: FakeWatchRepository;
let api: ReturnType<typeof makeReplayApi>;

beforeEach(() => {
  watchRepo = new FakeWatchRepository();
  watchRepo.add("btc-1h", minimalConfig);
  const marketDataFetchers = new Map();
  marketDataFetchers.set("fake", new FakeMarketDataFetcher());
  deps = {
    sessionsRepo: new InMemoryReplaySessionRepository(),
    replayEventStore: new InMemoryReplayEventStore(),
    replayLlmCallStore: new InMemoryReplayLLMCallStore(),
    cacheStore: new InMemoryLLMResponseCacheStore(),
    liveEventQuery: new InMemoryLiveEventQueryByWindow(),
    watchRepo,
    marketDataFetchers,
    clock: new FakeClock(new Date("2026-05-08T12:00:00.000Z")),
  };
  api = makeReplayApi(deps);
});

function postCreate(body: unknown): Request {
  return new Request("http://x/api/replay/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/replay/sessions", () => {
  test("valid request → 201, session created with defaults", async () => {
    const res = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      session: {
        id: string;
        status: string;
        lessonsMode: string;
        feedbackMode: string;
        costCapUsd: number;
      };
      baselineEventsCopied: number;
    };
    expect(body.session.status).toBe("READY");
    expect(body.session.lessonsMode).toBe("current");
    expect(body.session.feedbackMode).toBe("run");
    expect(body.session.costCapUsd).toBe(5);
    expect(body.baselineEventsCopied).toBe(0);
  });

  test("custom lessons_mode and feedback_mode are persisted", async () => {
    const res = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
        lessonsMode: "historical",
        feedbackMode: "skip",
      }),
    );
    const body = (await res.json()) as { session: { lessonsMode: string; feedbackMode: string } };
    expect(body.session.lessonsMode).toBe("historical");
    expect(body.session.feedbackMode).toBe("skip");
  });

  test("invalid window (end <= start) → 400 with reason window_invalid", async () => {
    const res = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-13T14:00:00.000Z",
        windowEndAt: "2026-04-12T14:00:00.000Z",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("window_invalid");
  });

  test("window includes future → 400 with reason window_includes_future", async () => {
    const res = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-06-01T00:00:00.000Z", // after clock=2026-05-08
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("window_includes_future");
  });

  test("window > 300 candles → 400 with reason window_too_large", async () => {
    const res = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-03-01T00:00:00.000Z",
        windowEndAt: "2026-04-01T00:00:00.000Z", // 30d × 24 = 720 candles on 1h
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("window_too_large");
  });

  test("unknown watchId → 404", async () => {
    const res = await api.create(
      postCreate({
        watchId: "unknown",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    expect(res.status).toBe(404);
  });

  test("baseline live events are copied", async () => {
    const liveQuery = deps.liveEventQuery as InMemoryLiveEventQueryByWindow;
    const setupId = crypto.randomUUID();
    liveQuery.events.push({
      setupId,
      watchId: "btc-1h",
      occurredAt: new Date("2026-04-12T15:00:00.000Z"),
      sequence: 1,
      stage: "detector",
      actor: "detector_v3",
      type: "DetectorTickProcessed",
      scoreDelta: 0,
      scoreAfter: null,
      statusBefore: null,
      statusAfter: null,
      payload: {
        type: "DetectorTickProcessed",
        data: { ignoreReason: "no pattern" },
      },
      provider: null,
      model: null,
      promptVersion: null,
      inputHash: null,
      latencyMs: null,
    });
    const res = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await res.json()) as { session: { id: string }; baselineEventsCopied: number };
    expect(body.baselineEventsCopied).toBe(1);

    const events = await deps.replayEventStore.listBySession(body.session.id);
    expect(events.length).toBe(1);
    expect(events[0]?.setupId).toBe(setupId);
  });

  test("configSnapshot is the current watch config (immutable for session)", async () => {
    const res = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await res.json()) as { session: { configSnapshot: { id: string } } };
    expect(body.session.configSnapshot.id).toBe("btc-1h");
  });
});

describe("GET /api/replay/sessions/:id", () => {
  test("existing → 200", async () => {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const res = await api.get(new Request(`http://x/api/replay/sessions/${body.session.id}`), {
      id: body.session.id,
    });
    expect(res.status).toBe(200);
  });

  test("unknown → 404", async () => {
    const res = await api.get(new Request("http://x/api/replay/sessions/missing"), {
      id: "missing",
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/replay/sessions/:id", () => {
  test("existing → 204, get returns 404 afterwards", async () => {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const del = await api.delete(
      new Request(`http://x/api/replay/sessions/${body.session.id}`, { method: "DELETE" }),
      { id: body.session.id },
    );
    expect(del.status).toBe(204);
    const after = await api.get(new Request("http://x"), { id: body.session.id });
    expect(after.status).toBe(404);
  });

  test("unknown → 404", async () => {
    const res = await api.delete(new Request("http://x", { method: "DELETE" }), {
      id: "missing",
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/replay/sessions", () => {
  test("empty list", async () => {
    const res = await api.list(new Request("http://x/api/replay/sessions"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("filter by watchId", async () => {
    watchRepo.add("eth-4h", {
      ...minimalConfig,
      id: "eth-4h",
      asset: { symbol: "ETHUSDT", source: "fake" },
      timeframes: { primary: "4h", higher: [] },
    } as unknown as WatchConfig);
    await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    await api.create(
      postCreate({
        watchId: "eth-4h",
        windowStartAt: "2026-04-10T00:00:00.000Z",
        windowEndAt: "2026-04-12T00:00:00.000Z",
      }),
    );
    const res = await api.list(new Request("http://x/api/replay/sessions?watchId=eth-4h"));
    const body = (await res.json()) as { watchId: string }[];
    expect(body.length).toBe(1);
    expect(body[0]?.watchId).toBe("eth-4h");
  });

  test("filter by status", async () => {
    await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const res = await api.list(new Request("http://x/api/replay/sessions?status=READY"));
    const body = (await res.json()) as { status: string }[];
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((s) => s.status === "READY")).toBe(true);
  });

  test("invalid status → 400", async () => {
    const res = await api.list(new Request("http://x/api/replay/sessions?status=BOGUS"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/replay/sessions/:id/events", () => {
  test("returns events in sequence order", async () => {
    const liveQuery = deps.liveEventQuery as InMemoryLiveEventQueryByWindow;
    for (let i = 0; i < 3; i++) {
      liveQuery.events.push({
        setupId: crypto.randomUUID(),
        watchId: "btc-1h",
        occurredAt: new Date(`2026-04-12T${15 + i}:00:00.000Z`),
        sequence: 1,
        stage: "detector",
        actor: "detector_v3",
        type: "DetectorTickProcessed",
        scoreDelta: 0,
        scoreAfter: null,
        statusBefore: null,
        statusAfter: null,
        payload: { type: "DetectorTickProcessed", data: { ignoreReason: `t${i}` } },
        provider: null,
        model: null,
        promptVersion: null,
        inputHash: null,
        latencyMs: null,
      });
    }
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const res = await api.events(
      new Request(`http://x/api/replay/sessions/${body.session.id}/events`),
      {
        id: body.session.id,
      },
    );
    expect(res.status).toBe(200);
    const events = (await res.json()) as { sequence: number }[];
    expect(events.length).toBe(3);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });
});

describe("GET /api/replay/sessions/:id/cost-breakdown", () => {
  test("empty session → empty breakdown", async () => {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const res = await api.costBreakdown(new Request("http://x"), { id: body.session.id });
    const out = (await res.json()) as {
      sessionId: string;
      costUsdSoFar: number;
      costCapUsd: number;
      byStage: unknown[];
    };
    expect(out.sessionId).toBe(body.session.id);
    expect(out.costCapUsd).toBe(5);
    expect(out.costUsdSoFar).toBe(0);
    expect(out.byStage).toEqual([]);
  });
});

describe("GET /api/replay/sessions/:id/setups (projection)", () => {
  test("session with no events → []", async () => {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const res = await api.setupsProjection(new Request("http://x"), { id: body.session.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("session with SetupCreated event → 1 projection", async () => {
    const liveQuery = deps.liveEventQuery as InMemoryLiveEventQueryByWindow;
    const setupId = crypto.randomUUID();
    liveQuery.events.push({
      setupId,
      watchId: "btc-1h",
      occurredAt: new Date("2026-04-12T15:00:00.000Z"),
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
    });
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const res = await api.setupsProjection(new Request("http://x"), { id: body.session.id });
    const projections = (await res.json()) as Array<{
      setupId: string;
      direction: string;
      patternHint: string;
    }>;
    expect(projections.length).toBe(1);
    expect(projections[0]?.setupId).toBe(setupId);
    expect(projections[0]?.direction).toBe("LONG");
    expect(projections[0]?.patternHint).toBe("bos_reaction");
  });
});

describe("GET /api/replay/sessions/:id/ohlcv", () => {
  test("returns candles + window metadata", async () => {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const res = await api.ohlcv(new Request("http://x"), { id: body.session.id });
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      symbol: string;
      source: string;
      timeframe: string;
      from: string;
      to: string;
      windowStartAt: string;
      windowEndAt: string;
      candles: unknown[];
    };
    expect(out.symbol).toBe("BTCUSDT");
    expect(out.source).toBe("fake");
    expect(out.timeframe).toBe("1h");
    expect(out.windowStartAt).toBe("2026-04-12T14:00:00.000Z");
    expect(out.windowEndAt).toBe("2026-04-13T14:00:00.000Z");
    // 200 lookback candles * 60 minutes = 12000 minutes before window start
    const expectedFrom = new Date("2026-04-12T14:00:00.000Z").getTime() - 200 * 60 * 60_000;
    expect(new Date(out.from).getTime()).toBe(expectedFrom);
  });

  test("unknown source → 404", async () => {
    watchRepo.add("unsupported-1h", {
      id: "unsupported-1h",
      asset: { symbol: "FOO", source: "doesnt-exist" },
      timeframes: { primary: "1h", higher: [] },
      candles: { detector_lookback: 200, reviewer_chart_window: 60 },
    } as unknown as WatchConfig);
    const created = await api.create(
      postCreate({
        watchId: "unsupported-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const res = await api.ohlcv(new Request("http://x"), { id: body.session.id });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/replay/sessions/:id/llm-calls", () => {
  test("empty session → []", async () => {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const res = await api.llmCalls(new Request("http://x"), { id: body.session.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
