import { beforeEach, describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { clearPromptCache } from "@adapters/prompts/loadPrompt";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { FewShotEngine } from "@domain/services/FewShotEngine";
import { PromptBuilder } from "@domain/services/PromptBuilder";
import { FakeChartRenderer } from "@test-fakes/FakeChartRenderer";
import { FakeIndicatorCalculator } from "@test-fakes/FakeIndicatorCalculator";
import { FakeLLMProvider } from "@test-fakes/FakeLLMProvider";
import { FakeMarketDataFetcher } from "@test-fakes/FakeMarketDataFetcher";
import { InMemoryArtifactStore } from "@test-fakes/InMemoryArtifactStore";
import { InMemoryLessonStore } from "@test-fakes/InMemoryLessonStore";
import { InMemoryLLMResponseCacheStore } from "@test-fakes/InMemoryLLMResponseCacheStore";
import { InMemoryReplayEventStore } from "@test-fakes/InMemoryReplayEventStore";
import { InMemoryReplayLLMCallStore } from "@test-fakes/InMemoryReplayLLMCallStore";
import { InMemoryReplaySessionRepository } from "@test-fakes/InMemoryReplaySessionRepository";
import type { ReplayActivityDeps } from "@workflows/replay/activityDependencies";
import { buildReplayActivities } from "@workflows/replay/activities";

const watchId = "btc-1h";
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeWatch(): WatchConfig {
  const cfg: unknown = {
    id: watchId,
    enabled: true,
    asset: { symbol: "BTCUSDT", source: "fake" },
    timeframes: { primary: "1h", higher: [] },
    schedule: { detector_cron: "*/15 * * * *", timezone: "UTC" },
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
    setup_lifecycle: {
      ttl_candles: 50,
      score_initial: 25,
      score_threshold_finalizer: 80,
      score_threshold_dead: 10,
      score_max: 100,
      invalidation_policy: "strict",
    },
    history_compaction: { max_raw_events_in_context: 40, summarize_after_age_hours: 48 },
    deduplication: { similar_setup_window_candles: 5, similar_price_tolerance_pct: 0.5 },
    pre_filter: {
      enabled: true,
      mode: "lenient",
      thresholds: {
        atr_ratio_min: 1.3,
        volume_spike_min: 1.5,
        rsi_extreme_distance: 25,
        near_pivot_distance_pct: 0.3,
      },
    },
    analyzers: {
      detector: { provider: "fake", model: "fake", max_tokens: 2000 },
      reviewer: { provider: "fake", model: "fake", max_tokens: 2000 },
      finalizer: { provider: "fake", model: "fake", max_tokens: 2000 },
      feedback: { provider: "fake", model: "fake" },
    },
    optimization: { reviewer_skip_when_detector_corroborated: true },
    notify_on: [],
    include_chart_image: false,
    include_reasoning: true,
    budget: { pause_on_budget_exceeded: false },
    feedback: {
      enabled: true,
      max_active_lessons_per_category: 30,
      injection: { detector: true, reviewer: true, finalizer: true },
      context_providers_disabled: [],
    },
    indicators: {},
  };
  return cfg as WatchConfig;
}

type Harness = {
  deps: ReplayActivityDeps;
  llm: FakeLLMProvider;
  sessionsRepo: InMemoryReplaySessionRepository;
  replayEventStore: InMemoryReplayEventStore;
  replayLlmCallStore: InMemoryReplayLLMCallStore;
  cacheStore: InMemoryLLMResponseCacheStore;
  lessonStore: InMemoryLessonStore;
  tickAt: Date;
  windowStartAt: Date;
};

async function buildHarness(opts?: {
  lessonsMode?: "current" | "historical" | "disabled";
  detectorParsed?: unknown;
  detectorCost?: number;
}): Promise<Harness> {
  const watch = makeWatch();
  const windowStartAt = new Date("2026-04-29T00:00:00Z");
  const windowEndAt = new Date("2026-04-30T00:00:00Z");
  const tickAt = new Date("2026-04-29T12:00:00Z");

  const sessionsRepo = new InMemoryReplaySessionRepository();
  await sessionsRepo.create({
    id: sessionId,
    watchId,
    name: "test-session",
    status: "READY",
    windowStartAt,
    windowEndAt,
    workflowId: `replay-session-${sessionId}`,
    configSnapshot: watch,
    lessonsMode: opts?.lessonsMode ?? "current",
    feedbackMode: "skip",
    costCapUsd: 5,
  });

  const fetcher = new FakeMarketDataFetcher();
  // 200 hourly candles ending at tickAt — gives the detector enough lookback.
  const candles = FakeMarketDataFetcher.generateLinear(200, 30_000);
  fetcher.seed("BTCUSDT", "1h", candles);
  const fetchers = new Map([["fake", fetcher]]);

  const llm = new FakeLLMProvider({
    name: "fake",
    available: true,
    completeImpl: async () => ({
      content: "{}",
      parsed: opts?.detectorParsed ?? {
        corroborations: [],
        new_setups: [],
        ignore_reason: "nothing",
      },
      costUsd: opts?.detectorCost ?? 0.42,
      latencyMs: 1234,
      promptTokens: 50,
      completionTokens: 25,
    }),
  });
  const llmProviders = new Map<string, LLMProvider>([["fake", llm]]);

  const indicatorRegistry = new IndicatorRegistry();
  const promptBuilder = new PromptBuilder(indicatorRegistry, new FewShotEngine());
  await promptBuilder.warmUp();

  const indicatorCalc = new FakeIndicatorCalculator();
  // Naked watch (indicators={}): empty scalars required by the strict schema.
  indicatorCalc.fixed = {};

  const deps: ReplayActivityDeps = {
    marketDataFetchers: fetchers,
    chartRenderer: new FakeChartRenderer(),
    indicatorCalculator: indicatorCalc,
    indicatorRegistry,
    promptBuilder,
    artifactStore: new InMemoryArtifactStore(),
    fundingRateProviders: new Map(),
    llmProviders,
    lessonStore: new InMemoryLessonStore(),
    sessionsRepo,
    replayEventStore: new InMemoryReplayEventStore(),
    replayLlmCallStore: new InMemoryReplayLLMCallStore(),
    cacheStore: new InMemoryLLMResponseCacheStore(),
  };

  return {
    deps,
    llm,
    sessionsRepo,
    replayEventStore: deps.replayEventStore as InMemoryReplayEventStore,
    replayLlmCallStore: deps.replayLlmCallStore as InMemoryReplayLLMCallStore,
    cacheStore: deps.cacheStore as InMemoryLLMResponseCacheStore,
    lessonStore: deps.lessonStore as InMemoryLessonStore,
    tickAt,
    windowStartAt,
  };
}

describe("runDetectorReplay", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  test("calls LLM, persists DetectorTickProcessed, records llm_call, increments session cost", async () => {
    const h = await buildHarness();
    const activities = buildReplayActivities(h.deps);

    const result = await activities.runDetectorReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      aliveSetups: [],
    });

    expect(h.llm.callCount).toBe(1);
    expect(result.cacheHit).toBe(false);
    expect(result.costUsd).toBeCloseTo(0.42, 5);
    expect(result.chartUri).toMatch(/^mem:\/\//);
    expect(result.ohlcvUri).toMatch(/^mem:\/\//);

    const events = await h.replayEventStore.listBySession(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("DetectorTickProcessed");
    expect(events[0]?.cacheHit).toBe(false);
    expect(events[0]?.provider).toBe("fake");

    expect(h.replayLlmCallStore.calls).toHaveLength(1);
    expect(h.replayLlmCallStore.calls[0]?.stage).toBe("detector");
    expect(h.replayLlmCallStore.calls[0]?.cacheHit).toBe(false);
    expect(h.replayLlmCallStore.calls[0]?.costUsd).toBeCloseTo(0.42, 5);

    const session = await h.sessionsRepo.get(sessionId);
    expect(session?.costUsdSoFar).toBeCloseTo(0.42, 5);
  });

  test("second identical call hits the cache: cost not re-incremented, cacheHit=true", async () => {
    const h = await buildHarness();
    const activities = buildReplayActivities(h.deps);

    const first = await activities.runDetectorReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      aliveSetups: [],
    });
    expect(first.cacheHit).toBe(false);
    expect(h.llm.callCount).toBe(1);

    const second = await activities.runDetectorReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      aliveSetups: [],
    });

    // Cache hit short-circuited the inner provider.
    expect(h.llm.callCount).toBe(1);
    expect(second.cacheHit).toBe(true);
    expect(second.costUsd).toBe(0);

    // Two events appended (one per call), the second marked cache hit.
    const events = await h.replayEventStore.listBySession(sessionId);
    expect(events).toHaveLength(2);
    expect(events[1]?.cacheHit).toBe(true);

    // Only the first call incremented session cost.
    const session = await h.sessionsRepo.get(sessionId);
    expect(session?.costUsdSoFar).toBeCloseTo(0.42, 5);

    // Two llm_call rows: one miss, one hit.
    expect(h.replayLlmCallStore.calls).toHaveLength(2);
    expect(h.replayLlmCallStore.calls[1]?.cacheHit).toBe(true);
    expect(h.replayLlmCallStore.calls[1]?.costUsd).toBe(0);
  });

  test("lessonsMode=disabled injects no lessons into the detector prompt", async () => {
    const h = await buildHarness({ lessonsMode: "disabled" });
    await h.lessonStore.create({
      id: "11111111-1111-4111-8111-111111111111",
      watchId,
      category: "detecting",
      title: "ZZ-DISABLED-LESSON-MARKER",
      body: "This must NOT appear in the prompt when lessonsMode=disabled.",
      rationale: "Test marker.",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    const activities = buildReplayActivities(h.deps);

    await activities.runDetectorReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      aliveSetups: [],
    });

    expect(h.llm.callsLog).toHaveLength(1);
    expect(h.llm.callsLog[0]?.userPrompt ?? "").not.toContain("ZZ-DISABLED-LESSON-MARKER");

    // Live lesson stats must not have been touched.
    const after = await h.lessonStore.getById("11111111-1111-4111-8111-111111111111");
    expect(after?.timesUsedInPrompts).toBe(0);
  });

  test("lessonsMode=current includes active lessons in the prompt and does NOT mutate usage stats", async () => {
    const h = await buildHarness({ lessonsMode: "current" });
    const lessonId = "22222222-2222-4222-8222-222222222222";
    await h.lessonStore.create({
      id: lessonId,
      watchId,
      category: "detecting",
      title: "ZZ-CURRENT-LESSON-MARKER",
      body: "Skip setups with anemic volume even when RSI is extreme.",
      rationale: "Test marker.",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    const activities = buildReplayActivities(h.deps);

    await activities.runDetectorReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      aliveSetups: [],
    });

    expect(h.llm.callsLog[0]?.userPrompt ?? "").toContain("ZZ-CURRENT-LESSON-MARKER");

    // Replay must NOT bump usage counters on live lessons.
    const after = await h.lessonStore.getById(lessonId);
    expect(after?.timesUsedInPrompts).toBe(0);
  });

  test("lessonsMode=historical excludes lessons activated AFTER windowStartAt", async () => {
    const h = await buildHarness({ lessonsMode: "historical" });
    // Activated AFTER the window start → must be filtered out.
    const futureLessonId = "33333333-3333-4333-8333-333333333333";
    await h.lessonStore.create({
      id: futureLessonId,
      watchId,
      category: "detecting",
      title: "ZZ-FUTURE-LESSON-MARKER",
      body: "Body that must not appear.",
      rationale: "Test marker.",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    // activatedAt is set to "now" by InMemoryLessonStore.create when status=ACTIVE,
    // which is AFTER 2026-04-29 windowStartAt — exactly the case we want to filter.

    const activities = buildReplayActivities(h.deps);
    await activities.runDetectorReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      aliveSetups: [],
    });

    expect(h.llm.callsLog[0]?.userPrompt ?? "").not.toContain("ZZ-FUTURE-LESSON-MARKER");
  });
});
