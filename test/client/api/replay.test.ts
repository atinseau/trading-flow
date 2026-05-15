import { beforeEach, describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import { makeReplayApi, type ReplayApiDeps } from "@client/api/replay";
import type { WatchRepository, WatchValidationResult } from "@domain/ports/WatchRepository";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { FakeClock } from "../../fakes/FakeClock";
import { FakeMarketDataFetcher } from "../../fakes/FakeMarketDataFetcher";
import { FakeReplaySignalSender } from "../../fakes/FakeReplaySignalSender";
import { InMemoryLessonEventStore } from "../../fakes/InMemoryLessonEventStore";
import { InMemoryLessonStore } from "../../fakes/InMemoryLessonStore";
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
let signaller: FakeReplaySignalSender;
let api: ReturnType<typeof makeReplayApi>;

beforeEach(() => {
  watchRepo = new FakeWatchRepository();
  watchRepo.add("btc-1h", minimalConfig);
  const marketDataFetchers = new Map();
  marketDataFetchers.set("fake", new FakeMarketDataFetcher());
  signaller = new FakeReplaySignalSender();
  deps = {
    sessionsRepo: new InMemoryReplaySessionRepository(),
    replayEventStore: new InMemoryReplayEventStore(),
    replayLlmCallStore: new InMemoryReplayLLMCallStore(),
    cacheStore: new InMemoryLLMResponseCacheStore(),
    liveEventQuery: new InMemoryLiveEventQueryByWindow(),
    watchRepo,
    marketDataFetchers,
    clock: new FakeClock(new Date("2026-05-08T12:00:00.000Z")),
    signaller,
    lessonStore: new InMemoryLessonStore(),
    lessonEventStore: new InMemoryLessonEventStore(),
    indicatorRegistry: new IndicatorRegistry(),
    indicatorCalculator: new PureJsIndicatorCalculator(),
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

  test("response includes indicators map (empty when no indicators enabled)", async () => {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const res = await api.ohlcv(new Request("http://x"), { id: body.session.id });
    const out = (await res.json()) as { indicators?: Record<string, unknown> };
    expect(typeof out.indicators).toBe("object");
    // minimalConfig has no `indicators` matrix → resolveActive returns []
    // → computeSeries skipped → empty object.
    expect(Object.keys(out.indicators ?? {})).toEqual([]);
  });

  test("response includes indicator series for each enabled plugin", async () => {
    watchRepo.add("btc-1h-rsi", {
      id: "btc-1h-rsi",
      asset: { symbol: "BTCUSDT", source: "fake" },
      timeframes: { primary: "1h", higher: [] },
      candles: { detector_lookback: 200, reviewer_chart_window: 60 },
      indicators: {
        rsi: { enabled: true, params: { period: 14 } },
        volume: { enabled: true },
        ema_stack: {
          enabled: true,
          params: { period_short: 20, period_mid: 50, period_long: 200 },
        },
      },
    } as unknown as WatchConfig);
    const created = await api.create(
      postCreate({
        watchId: "btc-1h-rsi",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    const res = await api.ohlcv(new Request("http://x"), { id: body.session.id });
    const out = (await res.json()) as {
      candles: unknown[];
      indicators: Record<string, { kind: string }>;
    };
    // FakeMarketDataFetcher returns [] by default — that's fine for shape
    // assertions on the indicators map (each plugin computes a contribution
    // even on an empty series).
    expect(Object.keys(out.indicators).sort()).toEqual(["ema_stack", "rsi", "volume"].sort());
    // Each contribution has a `kind` discriminant.
    for (const id of ["ema_stack", "rsi", "volume"]) {
      expect(typeof out.indicators[id]?.kind).toBe("string");
    }
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

describe("POST /api/replay/sessions/:id/step", () => {
  function postStep(id: string, body: unknown): Request {
    return new Request(`http://x/api/replay/sessions/${id}/step`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function createTestSession(): Promise<string> {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    return body.session.id;
  }

  test("dispatches a step signal with the body tickAt", async () => {
    const id = await createTestSession();
    const res = await api.step(postStep(id, { tickAt: "2026-04-12T16:00:00.000Z" }), { id });
    expect(res.status).toBe(200);
    expect(signaller.calls).toHaveLength(1);
    expect(signaller.calls[0]).toEqual({
      kind: "step",
      sessionId: id,
      tickAt: "2026-04-12T16:00:00.000Z",
    });
  });

  test("404 when session does not exist", async () => {
    const res = await api.step(
      postStep("00000000-0000-4000-8000-000000000000", {
        tickAt: "2026-04-12T16:00:00.000Z",
      }),
      { id: "00000000-0000-4000-8000-000000000000" },
    );
    expect(res.status).toBe(404);
    expect(signaller.calls).toHaveLength(0);
  });

  test("400 when tickAt falls outside the session window", async () => {
    const id = await createTestSession();
    const res = await api.step(postStep(id, { tickAt: "2026-04-15T12:00:00.000Z" }), { id });
    expect(res.status).toBe(400);
    expect(signaller.calls).toHaveLength(0);
  });

  test("400 when session is COMPLETED", async () => {
    const id = await createTestSession();
    const sessionsRepo = deps.sessionsRepo as InMemoryReplaySessionRepository;
    await sessionsRepo.updateStatus(id, "COMPLETED");
    const res = await api.step(postStep(id, { tickAt: "2026-04-12T16:00:00.000Z" }), { id });
    expect(res.status).toBe(400);
    expect(signaller.calls).toHaveLength(0);
  });

  test("400 when tickAt is not aligned on the timeframe", async () => {
    const id = await createTestSession();
    // 1h timeframe, windowStartAt = 14:00 → 14:03 is misaligned by 3 min.
    const res = await api.step(postStep(id, { tickAt: "2026-04-12T14:03:00.000Z" }), { id });
    expect(res.status).toBe(400);
    expect(signaller.calls).toHaveLength(0);
  });

  test("accepts tickAt at the window's exact start boundary", async () => {
    const id = await createTestSession();
    const res = await api.step(postStep(id, { tickAt: "2026-04-12T14:00:00.000Z" }), { id });
    expect(res.status).toBe(200);
    expect(signaller.calls).toEqual([
      { kind: "step", sessionId: id, tickAt: "2026-04-12T14:00:00.000Z" },
    ]);
  });

  test("accepts tickAt at the window's exact end boundary", async () => {
    const id = await createTestSession();
    // windowEnd = 2026-04-13T14:00:00 — aligned on 1h timeframe.
    const res = await api.step(postStep(id, { tickAt: "2026-04-13T14:00:00.000Z" }), { id });
    expect(res.status).toBe(200);
  });

  test("accepts a batched tickAts array and dispatches one signal", async () => {
    const id = await createTestSession();
    const res = await api.step(
      postStep(id, {
        tickAts: [
          "2026-04-12T15:00:00.000Z",
          "2026-04-12T16:00:00.000Z",
          "2026-04-12T17:00:00.000Z",
        ],
      }),
      { id },
    );
    expect(res.status).toBe(200);
    expect(signaller.calls).toHaveLength(1);
    expect(signaller.calls[0]).toEqual({
      kind: "step",
      sessionId: id,
      tickAts: ["2026-04-12T15:00:00.000Z", "2026-04-12T16:00:00.000Z", "2026-04-12T17:00:00.000Z"],
    });
  });

  test("400 when any tickAt in the batch is misaligned", async () => {
    const id = await createTestSession();
    const res = await api.step(
      postStep(id, {
        tickAts: ["2026-04-12T15:00:00.000Z", "2026-04-12T16:03:00.000Z"],
      }),
      { id },
    );
    expect(res.status).toBe(400);
    expect(signaller.calls).toHaveLength(0);
  });

  test("400 when both tickAt and tickAts are provided", async () => {
    const id = await createTestSession();
    const res = await api.step(
      postStep(id, {
        tickAt: "2026-04-12T15:00:00.000Z",
        tickAts: ["2026-04-12T15:00:00.000Z"],
      }),
      { id },
    );
    expect(res.status).toBe(400);
    expect(signaller.calls).toHaveLength(0);
  });
});

describe("POST /api/replay/sessions/:id/pause + /resume", () => {
  async function createTestSession(): Promise<string> {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    return body.session.id;
  }

  test("pause dispatches a pause signal", async () => {
    const id = await createTestSession();
    const res = await api.pause(new Request("http://x", { method: "POST" }), { id });
    expect(res.status).toBe(200);
    expect(signaller.calls).toEqual([{ kind: "pause", sessionId: id }]);
  });

  test("resume dispatches a resume signal", async () => {
    const id = await createTestSession();
    const res = await api.resume(new Request("http://x", { method: "POST" }), { id });
    expect(res.status).toBe(200);
    expect(signaller.calls).toEqual([{ kind: "resume", sessionId: id }]);
  });

  test("pause refuses on terminal status", async () => {
    const id = await createTestSession();
    const sessionsRepo = deps.sessionsRepo as InMemoryReplaySessionRepository;
    await sessionsRepo.updateStatus(id, "FAILED");
    const res = await api.pause(new Request("http://x", { method: "POST" }), { id });
    expect(res.status).toBe(400);
    expect(signaller.calls).toHaveLength(0);
  });
});

describe("GET /api/replay/sessions/:id/workflow-state", () => {
  async function createTestSession(): Promise<string> {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    return body.session.id;
  }

  test("returns { live: null } when no workflow is running yet", async () => {
    const id = await createTestSession();
    // signaller defaults to `workflowState: null` (FakeReplaySignalSender) —
    // mimics the case where the user just created the session and hasn't
    // dispatched any step.
    const res = await api.workflowState(new Request("http://x"), { id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { live: unknown };
    expect(body.live).toBeNull();
    expect(signaller.calls).toEqual([{ kind: "getWorkflowState", sessionId: id }]);
  });

  test("passes the signaller's live state through verbatim", async () => {
    const id = await createTestSession();
    // The endpoint should be a thin pass-through ; serialization is the
    // signaller's responsibility (which uses Temporal's JSON converter
    // in production).
    signaller.workflowState = {
      status: "READY",
      lastTickAt: "2026-04-12T14:30:00.000Z",
      aliveSetups: [
        {
          id: "setup-1",
          status: "REVIEWING",
          score: 75,
          invalidationLevel: 29_500,
          direction: "LONG",
          patternHint: "bullish_engulfing",
        },
      ],
      costUsdSoFar: 0.42,
      tickInProgress: true,
      pendingTicks: 3,
    };
    const res = await api.workflowState(new Request("http://x"), { id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { live: typeof signaller.workflowState };
    expect(body.live).toEqual(signaller.workflowState);
  });

  test("404 on unknown session", async () => {
    const res = await api.workflowState(new Request("http://x"), {
      id: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.status).toBe(404);
    // Must NOT call the signaller for an unknown session — the API short-
    // circuits before issuing a Temporal query.
    expect(signaller.calls).toHaveLength(0);
  });
});

describe("POST /api/replay/sessions/:id/terminate", () => {
  async function createTestSession(): Promise<string> {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const body = (await created.json()) as { session: { id: string } };
    return body.session.id;
  }

  test("dispatches terminate signal with optional reason", async () => {
    const id = await createTestSession();
    const req = new Request("http://x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "user_abort" }),
    });
    const res = await api.terminate(req, { id });
    expect(res.status).toBe(200);
    expect(signaller.calls).toEqual([{ kind: "terminate", sessionId: id, reason: "user_abort" }]);
  });

  test("400 on terminal session", async () => {
    const id = await createTestSession();
    const sessionsRepo = deps.sessionsRepo as InMemoryReplaySessionRepository;
    await sessionsRepo.updateStatus(id, "COMPLETED");
    const res = await api.terminate(new Request("http://x", { method: "POST" }), { id });
    expect(res.status).toBe(400);
    expect(signaller.calls).toHaveLength(0);
  });
});

describe("DELETE /api/replay/sessions/:id with terminate side-effect", () => {
  test("dispatches a terminate signal before deleting (best-effort)", async () => {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const { session } = (await created.json()) as { session: { id: string } };
    const id = session.id;
    const res = await api.delete(new Request("http://x", { method: "DELETE" }), { id });
    expect(res.status).toBe(204);
    expect(signaller.calls).toEqual([
      { kind: "terminate", sessionId: id, reason: "session_deleted" },
    ]);
    // Session is gone from the in-memory repo.
    const after = await deps.sessionsRepo.get(id);
    expect(after).toBeNull();
  });
});

describe("POST /api/replay/sessions/:id/events/:eventId/promote", () => {
  async function createSessionWithFeedbackProposal(
    action: "CREATE" | "REINFORCE" | "REFINE" | "DEPRECATE",
    extra?: {
      supersedesLessonId?: string;
      category?: "detecting" | "reviewing" | "finalizing";
      omitCategory?: boolean;
    },
  ): Promise<{ sessionId: string; eventId: string }> {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const { session } = (await created.json()) as { session: { id: string } };
    const sessionId = session.id;
    const replayEventStore = deps.replayEventStore as InMemoryReplayEventStore;
    const evt = await replayEventStore.append(sessionId, {
      setupId: "00000000-0000-4000-8000-000000000099",
      occurredAt: new Date(),
      stage: "feedback",
      actor: "test",
      type: "FeedbackLessonProposed",
      scoreDelta: 0,
      payload: {
        type: "FeedbackLessonProposed",
        data: {
          action,
          // Default to "reviewing" for CREATE proposals so existing tests
          // keep their semantics ; pass `omitCategory: true` to exercise
          // the legacy-event guard in the promote endpoint.
          ...(action === "CREATE" && !extra?.omitCategory
            ? { category: extra?.category ?? "reviewing" }
            : {}),
          title: "Demand fresh volume above the prior swing high",
          body: "When price approaches the prior swing high without a notable uptick in relative volume, downgrade the confluence rating.",
          rationale: "Past failed setups consistently show flat volume at the contested level.",
          sourceTradeSetupId: "00000000-0000-4000-8000-000000000099",
          ...(extra?.supersedesLessonId ? { supersedesLessonId: extra.supersedesLessonId } : {}),
        },
      },
    });
    return { sessionId, eventId: evt.id };
  }

  test("CREATE → new lesson row in PENDING + CREATE lesson_event", async () => {
    const { sessionId, eventId } = await createSessionWithFeedbackProposal("CREATE");
    const res = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: sessionId,
      eventId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { lessonId: string; action: string };
    expect(body.action).toBe("CREATE");
    const lessonStore = deps.lessonStore as InMemoryLessonStore;
    const lesson = await lessonStore.getById(body.lessonId);
    expect(lesson?.status).toBe("PENDING");
    expect(lesson?.title).toContain("fresh volume");
  });

  test("CREATE category is propagated from the payload (no hardcoded reviewing)", async () => {
    const { sessionId, eventId } = await createSessionWithFeedbackProposal("CREATE", {
      category: "detecting",
    });
    const res = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: sessionId,
      eventId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { lessonId: string; category: string };
    expect(body.category).toBe("detecting");
    const lessonStore = deps.lessonStore as InMemoryLessonStore;
    const lesson = await lessonStore.getById(body.lessonId);
    expect(lesson?.category).toBe("detecting");
  });

  test("400 when CREATE legacy event lacks category (predates the fix)", async () => {
    const { sessionId, eventId } = await createSessionWithFeedbackProposal("CREATE", {
      omitCategory: true,
    });
    const res = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: sessionId,
      eventId,
    });
    expect(res.status).toBe(400);
  });

  test("second promote on the same event returns alreadyPromoted=true (idempotent)", async () => {
    const { sessionId, eventId } = await createSessionWithFeedbackProposal("CREATE");
    await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: sessionId,
      eventId,
    });
    const second = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: sessionId,
      eventId,
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { alreadyPromoted: boolean };
    expect(body.alreadyPromoted).toBe(true);
    // The live lesson_events store has exactly one row for this proposal.
    const lessonEventStore = deps.lessonEventStore as InMemoryLessonEventStore;
    const events = await lessonEventStore.findByInputHash({
      watchId: "btc-1h",
      inputHash: `replay-promote:${eventId}`,
    });
    expect(events).toHaveLength(1);
  });

  test("REFINE → new lesson supersedes the old one (live lessons_events appended)", async () => {
    const lessonStore = deps.lessonStore as InMemoryLessonStore;
    const targetId = "66666666-6666-4666-8666-666666666666";
    await lessonStore.create({
      id: targetId,
      watchId: "btc-1h",
      category: "reviewing",
      title: "Old wording",
      body: "Old body body body body body body body body body body body body",
      rationale: "old rationale",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    const { sessionId, eventId } = await createSessionWithFeedbackProposal("REFINE", {
      supersedesLessonId: targetId,
    });
    const res = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: sessionId,
      eventId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { lessonId: string; action: string };
    expect(body.action).toBe("REFINE");
    // New lesson exists (refined supersede creates a new row pointing at the old).
    const newLesson = await lessonStore.getById(body.lessonId);
    expect(newLesson?.supersedesLessonId).toBe(targetId);
  });

  test("REFINE → 404 when the supersedesLessonId points to a missing lesson", async () => {
    const missingId = "77777777-7777-4777-8777-777777777777";
    const { sessionId, eventId } = await createSessionWithFeedbackProposal("REFINE", {
      supersedesLessonId: missingId,
    });
    const res = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: sessionId,
      eventId,
    });
    expect(res.status).toBe(404);
  });

  test("DEPRECATE → flips the live lesson from ACTIVE to DEPRECATED", async () => {
    const lessonStore = deps.lessonStore as InMemoryLessonStore;
    const targetId = "88888888-8888-4888-8888-888888888888";
    await lessonStore.create({
      id: targetId,
      watchId: "btc-1h",
      category: "reviewing",
      title: "About to be deprecated",
      body: "Body body body body body body body body body body body body body body",
      rationale: "rationale",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    const { sessionId, eventId } = await createSessionWithFeedbackProposal("DEPRECATE", {
      supersedesLessonId: targetId,
    });
    const res = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: sessionId,
      eventId,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lessonId: string; action: string };
    expect(body.action).toBe("DEPRECATE");
    expect(body.lessonId).toBe(targetId);
    const after = await lessonStore.getById(targetId);
    expect(after?.status).toBe("DEPRECATED");
  });

  test("DEPRECATE → 400 when supersedesLessonId is missing", async () => {
    const { sessionId, eventId } = await createSessionWithFeedbackProposal("DEPRECATE");
    // No supersedesLessonId in the proposal payload.
    const res = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: sessionId,
      eventId,
    });
    expect(res.status).toBe(400);
  });

  test("REINFORCE → incrementReinforced on the referenced live lesson", async () => {
    const lessonStore = deps.lessonStore as InMemoryLessonStore;
    const targetId = "55555555-5555-4555-8555-555555555555";
    await lessonStore.create({
      id: targetId,
      watchId: "btc-1h",
      category: "reviewing",
      title: "Existing lesson",
      body: "Body of the existing lesson xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      rationale: "rationale",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    const { sessionId, eventId } = await createSessionWithFeedbackProposal("REINFORCE", {
      supersedesLessonId: targetId,
    });
    const res = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: sessionId,
      eventId,
    });
    expect(res.status).toBe(200);
    const after = await lessonStore.getById(targetId);
    expect(after?.timesReinforced).toBe(1);
  });

  test("404 when the event id doesn't exist", async () => {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const { session } = (await created.json()) as { session: { id: string } };
    const res = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: session.id,
      eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    expect(res.status).toBe(404);
  });

  test("400 when the event is not a FeedbackLessonProposed", async () => {
    const created = await api.create(
      postCreate({
        watchId: "btc-1h",
        windowStartAt: "2026-04-12T14:00:00.000Z",
        windowEndAt: "2026-04-13T14:00:00.000Z",
      }),
    );
    const { session } = (await created.json()) as { session: { id: string } };
    const replayEventStore = deps.replayEventStore as InMemoryReplayEventStore;
    const evt = await replayEventStore.append(session.id, {
      setupId: null,
      occurredAt: new Date(),
      stage: "detector",
      actor: "test",
      type: "DetectorTickProcessed",
      scoreDelta: 0,
      payload: {
        type: "DetectorTickProcessed",
        data: { ignoreReason: null },
      },
    });
    const res = await api.promoteFeedbackLesson(new Request("http://x", { method: "POST" }), {
      id: session.id,
      eventId: evt.id,
    });
    expect(res.status).toBe(400);
  });
});
