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
import { buildReplayActivities, type ReplaySetupSnapshot } from "@workflows/replay/activities";
import type { ReplayActivityDeps } from "@workflows/replay/activityDependencies";

const watchId = "btc-1h";
const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const setupId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
      min_risk_reward_ratio: 2.0,
    },
    costs: { fees_pct: 0.1, slippage_pct: 0.05 },
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

function makeSetup(): ReplaySetupSnapshot {
  return {
    id: setupId,
    watchId,
    asset: "BTCUSDT",
    timeframe: "1h",
    patternHint: "bullish_engulfing",
    patternCategory: "event",
    expectedMaturationTicks: 3,
    direction: "LONG",
    currentScore: 60,
    invalidationLevel: 29_500,
  };
}

type Harness = {
  deps: ReplayActivityDeps;
  llm: FakeLLMProvider;
  sessionsRepo: InMemoryReplaySessionRepository;
  replayEventStore: InMemoryReplayEventStore;
  replayLlmCallStore: InMemoryReplayLLMCallStore;
  lessonStore: InMemoryLessonStore;
  tickAt: Date;
};

async function buildHarness(opts?: {
  reviewerParsed?: unknown;
  finalizerParsed?: unknown;
  llmCost?: number;
}): Promise<Harness> {
  const watch = makeWatch();
  const windowStartAt = new Date("2026-04-29T00:00:00Z");
  const windowEndAt = new Date("2026-04-30T00:00:00Z");
  const tickAt = new Date("2026-04-29T12:00:00Z");

  const sessionsRepo = new InMemoryReplaySessionRepository();
  await sessionsRepo.create({
    id: sessionId,
    watchId,
    name: "test",
    status: "READY",
    windowStartAt,
    windowEndAt,
    workflowId: `replay-session-${sessionId}`,
    configSnapshot: watch,
    lessonsMode: "current",
    feedbackMode: "skip",
    costCapUsd: 5,
  });

  const fetcher = new FakeMarketDataFetcher();
  // Seed hourly + daily candles so reviewer/finalizer HTF context fetches resolve.
  const hourly = FakeMarketDataFetcher.generateLinear(200, 30_000);
  fetcher.seed("BTCUSDT", "1h", hourly);
  const daily = FakeMarketDataFetcher.generateLinear(60, 30_000);
  fetcher.seed("BTCUSDT", "1d", daily);
  const fetchers = new Map([["fake", fetcher]]);

  const reviewerDefault = {
    type: "STRENGTHEN" as const,
    scoreDelta: 10,
    observations: [{ kind: "trend", text: "uptrend confirmed" }],
    reasoning: "Higher highs and higher lows visible on the chart.",
  };
  const finalizerDefault = {
    go: true,
    reasoning: "Setup meets the criteria.",
    entry: 30_100,
    stop_loss: 29_500,
    take_profit: [31_000, 32_000],
  };

  // Per-stage payloads — the same FakeLLMProvider serves all three stages.
  // The reviewer + finalizer system prompts each open with their role name
  // ("You are the Reviewer" / "You are the Finalizer"), giving a stable
  // routing key. Substring match on "finalizer" alone is insufficient: the
  // reviewer prompt also mentions "the Finalizer" downstream.
  const llm = new FakeLLMProvider({
    name: "fake",
    available: true,
    completeImpl: async (input) => {
      const sys = (input.systemPrompt ?? "").trim();
      const isFinalizer = /^You are the Finalizer/i.test(sys);
      const parsed = isFinalizer
        ? (opts?.finalizerParsed ?? finalizerDefault)
        : (opts?.reviewerParsed ?? reviewerDefault);
      return {
        content: JSON.stringify(parsed),
        parsed,
        costUsd: opts?.llmCost ?? 0.25,
        latencyMs: 500,
        promptTokens: 100,
        completionTokens: 50,
      };
    },
  });
  const llmProviders = new Map<string, LLMProvider>([["fake", llm]]);

  const indicatorRegistry = new IndicatorRegistry();
  const promptBuilder = new PromptBuilder(indicatorRegistry, new FewShotEngine());
  await promptBuilder.warmUp();

  const indicatorCalc = new FakeIndicatorCalculator();
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
    lessonStore: deps.lessonStore as InMemoryLessonStore,
    tickAt,
  };
}

describe("runReviewerReplay", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  test("returns a strict VerdictSchema-parseable verdict and records llm_call", async () => {
    const h = await buildHarness();
    const activities = buildReplayActivities(h.deps);

    // Seed a pre-existing chart artifact (would have been put by runDetectorReplay)
    const chart = await h.deps.artifactStore.put({
      kind: "chart_image",
      content: Buffer.from("chart-bytes"),
      mimeType: "image/png",
    });

    const result = await activities.runReviewerReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      setup: makeSetup(),
      chartUri: chart.uri,
      indicatorsJson: JSON.stringify({}),
      lastClose: 30_500,
    });

    expect(h.llm.callCount).toBe(1);
    expect(result.cacheHit).toBe(false);
    const verdict = JSON.parse(result.verdictJson);
    expect(verdict.type).toBe("STRENGTHEN");
    expect(verdict).not.toHaveProperty("request_additional"); // stripped before persist

    expect(h.replayLlmCallStore.calls).toHaveLength(1);
    expect(h.replayLlmCallStore.calls[0]?.stage).toBe("reviewer");
    expect(h.replayLlmCallStore.calls[0]?.setupId).toBe(setupId);

    const session = await h.sessionsRepo.get(sessionId);
    expect(session?.costUsdSoFar).toBeCloseTo(0.25, 5);
  });

  test("strips request_additional even when LLM emits it", async () => {
    const h = await buildHarness({
      reviewerParsed: {
        type: "WEAKEN",
        scoreDelta: -10,
        observations: [],
        reasoning: "Setup losing momentum.",
        request_additional: { htfChart: true, reason: "need wider view" },
      },
    });
    const activities = buildReplayActivities(h.deps);
    const chart = await h.deps.artifactStore.put({
      kind: "chart_image",
      content: Buffer.from("chart-bytes-2"),
      mimeType: "image/png",
    });

    const result = await activities.runReviewerReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      setup: makeSetup(),
      chartUri: chart.uri,
      indicatorsJson: JSON.stringify({}),
      lastClose: 30_500,
    });

    const verdict = JSON.parse(result.verdictJson);
    expect(verdict.type).toBe("WEAKEN");
    expect(verdict).not.toHaveProperty("request_additional");
  });

  test("HTF round-2 : request_additional.htfChart triggers a 2nd LLM call + reviewer_htf_chart stage", async () => {
    const h = await buildHarness({
      reviewerParsed: {
        type: "STRENGTHEN",
        scoreDelta: 5,
        observations: [{ kind: "trend", text: "uptrend" }],
        reasoning: "Need wider view.",
        request_additional: { htfChart: true, reason: "want daily" },
      },
    });
    const activities = buildReplayActivities(h.deps);
    const chart = await h.deps.artifactStore.put({
      kind: "chart_image",
      content: Buffer.from("htf-test-chart"),
      mimeType: "image/png",
    });

    const result = await activities.runReviewerReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      setup: makeSetup(),
      chartUri: chart.uri,
      indicatorsJson: JSON.stringify({}),
      lastClose: 30_500,
    });

    // Round-1 + Round-2 → LLM called twice.
    expect(h.llm.callCount).toBe(2);
    // The 2nd call should have two images (original chart + HTF chart).
    expect(h.llm.callsLog[1]?.images?.length).toBe(2);

    // Two llm_call rows : "reviewer" (round-1) + "reviewer_htf_chart" (round-2).
    expect(h.replayLlmCallStore.calls).toHaveLength(2);
    expect(h.replayLlmCallStore.calls[0]?.stage).toBe("reviewer");
    expect(h.replayLlmCallStore.calls[1]?.stage).toBe("reviewer_htf_chart");

    // promptVersion is tagged with `+htf2`.
    expect(result.promptVersion).toMatch(/\+htf2$/);

    // Cost reflects both rounds (0.25 × 2 = 0.50).
    expect(result.costUsd).toBeCloseTo(0.5, 5);
    const session = await h.sessionsRepo.get(sessionId);
    expect(session?.costUsdSoFar).toBeCloseTo(0.5, 5);
  });

  test("loads history scoped to setup.id from replay_events only", async () => {
    const h = await buildHarness();
    // Append events: one matching setup, one for an unrelated setup.
    await h.replayEventStore.append(sessionId, {
      setupId,
      occurredAt: new Date("2026-04-29T11:00:00Z"),
      stage: "system",
      actor: "test",
      type: "SetupCreated",
      scoreDelta: 60,
      scoreAfter: 60,
      payload: {
        type: "SetupCreated",
        data: {
          pattern: "bullish_engulfing",
          direction: "LONG",
          keyLevels: { invalidation: 29_500 },
          initialScore: 60,
          rawObservation: "engulfing on 1h",
        },
      },
    });
    const otherSetupId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await h.replayEventStore.append(sessionId, {
      setupId: otherSetupId,
      occurredAt: new Date("2026-04-29T11:30:00Z"),
      stage: "system",
      actor: "test",
      type: "SetupCreated",
      scoreDelta: 50,
      scoreAfter: 50,
      payload: {
        type: "SetupCreated",
        data: {
          pattern: "double_top",
          direction: "SHORT",
          keyLevels: { invalidation: 31_000 },
          initialScore: 50,
          rawObservation: "double top on 1h",
        },
      },
    });

    const activities = buildReplayActivities(h.deps);
    const chart = await h.deps.artifactStore.put({
      kind: "chart_image",
      content: Buffer.from("chart-bytes-3"),
      mimeType: "image/png",
    });

    await activities.runReviewerReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      setup: makeSetup(),
      chartUri: chart.uri,
      indicatorsJson: JSON.stringify({}),
      lastClose: 30_500,
    });

    // The prompt should mention the setup's own SetupCreated event sequence
    // (1), not the unrelated setup. We can't easily introspect the rendered
    // text, so check the LLM was called once and produced a verdict — and
    // that exactly one llm_call row was recorded.
    expect(h.llm.callCount).toBe(1);
    expect(h.replayLlmCallStore.calls[0]?.setupId).toBe(setupId);
  });
});

describe("runFinalizerReplay", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  test("returns a GO/NO_GO decision and records llm_call with stage=finalizer", async () => {
    const h = await buildHarness();
    const activities = buildReplayActivities(h.deps);

    const result = await activities.runFinalizerReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      setup: makeSetup(),
      latestIndicatorsJson: JSON.stringify({}),
      latestLastClose: 30_500,
    });

    expect(h.llm.callCount).toBe(1);
    expect(result.cacheHit).toBe(false);
    const decision = JSON.parse(result.decisionJson);
    expect(decision.go).toBe(true);
    expect(decision.entry).toBe(30_100);

    expect(h.replayLlmCallStore.calls).toHaveLength(1);
    expect(h.replayLlmCallStore.calls[0]?.stage).toBe("finalizer");
    expect(h.replayLlmCallStore.calls[0]?.setupId).toBe(setupId);

    const session = await h.sessionsRepo.get(sessionId);
    expect(session?.costUsdSoFar).toBeCloseTo(0.25, 5);
  });

  test("identical second call hits the cache: cost not re-incremented", async () => {
    const h = await buildHarness();
    const activities = buildReplayActivities(h.deps);
    const args = {
      sessionId,
      tickAt: h.tickAt.toISOString(),
      setup: makeSetup(),
      latestIndicatorsJson: JSON.stringify({}),
      latestLastClose: 30_500,
    };

    const first = await activities.runFinalizerReplay(args);
    expect(first.cacheHit).toBe(false);
    expect(h.llm.callCount).toBe(1);

    const second = await activities.runFinalizerReplay(args);
    expect(second.cacheHit).toBe(true);
    expect(second.costUsd).toBe(0);
    expect(h.llm.callCount).toBe(1); // cache short-circuited the inner provider

    const session = await h.sessionsRepo.get(sessionId);
    expect(session?.costUsdSoFar).toBeCloseTo(0.25, 5);

    expect(h.replayLlmCallStore.calls).toHaveLength(2);
    expect(h.replayLlmCallStore.calls[1]?.cacheHit).toBe(true);
  });

  test("NO_GO decision returns go=false with reasoning", async () => {
    const h = await buildHarness({
      finalizerParsed: { go: false, reasoning: "Risk-reward below minimum threshold." },
    });
    const activities = buildReplayActivities(h.deps);
    const result = await activities.runFinalizerReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      setup: makeSetup(),
      latestIndicatorsJson: JSON.stringify({}),
      latestLastClose: 30_500,
    });
    const decision = JSON.parse(result.decisionJson);
    expect(decision.go).toBe(false);
    expect(decision.reasoning).toContain("Risk-reward");
    expect(decision.entry).toBeUndefined();
  });
});

describe("runReviewerReplay verdict types", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  test("NEUTRAL verdict survives strict VerdictSchema parse", async () => {
    const h = await buildHarness({
      reviewerParsed: { type: "NEUTRAL", observations: [{ kind: "trend", text: "no change" }] },
    });
    const activities = buildReplayActivities(h.deps);
    const chart = await h.deps.artifactStore.put({
      kind: "chart_image",
      content: Buffer.from("ck-neutral"),
      mimeType: "image/png",
    });
    const r = await activities.runReviewerReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      setup: makeSetup(),
      chartUri: chart.uri,
      indicatorsJson: JSON.stringify({}),
      lastClose: 30_500,
    });
    const verdict = JSON.parse(r.verdictJson);
    expect(verdict.type).toBe("NEUTRAL");
    expect(verdict.observations).toHaveLength(1);
  });

  test("INVALIDATE verdict survives strict VerdictSchema parse", async () => {
    const h = await buildHarness({
      reviewerParsed: { type: "INVALIDATE", reason: "Price broke the invalidation level." },
    });
    const activities = buildReplayActivities(h.deps);
    const chart = await h.deps.artifactStore.put({
      kind: "chart_image",
      content: Buffer.from("ck-invalidate"),
      mimeType: "image/png",
    });
    const r = await activities.runReviewerReplay({
      sessionId,
      tickAt: h.tickAt.toISOString(),
      setup: makeSetup(),
      chartUri: chart.uri,
      indicatorsJson: JSON.stringify({}),
      lastClose: 30_500,
    });
    const verdict = JSON.parse(r.verdictJson);
    expect(verdict.type).toBe("INVALIDATE");
    expect(verdict.reason).toContain("invalidation");
  });
});
