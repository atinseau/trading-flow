/**
 * Activity-level tests for market-hours guards in runReviewer and runFinalizer.
 *
 * These are pure unit tests — no Temporal Worker, no real DB. We call the
 * activity functions directly via `buildSetupActivities(deps)` with in-memory
 * fakes and a controlled clock.
 */
import { describe, expect, test } from "bun:test";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { FakeClock } from "@test-fakes/FakeClock";
import { FakeLLMCallStore } from "@test-fakes/FakeLLMCallStore";
import { FakeLLMProvider } from "@test-fakes/FakeLLMProvider";
import { InMemoryArtifactStore } from "@test-fakes/InMemoryArtifactStore";
import { InMemoryEventStore } from "@test-fakes/InMemoryEventStore";
import { InMemorySetupRepository } from "@test-fakes/InMemorySetupRepository";
import { InMemoryTickSnapshotStore } from "@test-fakes/InMemoryTickSnapshotStore";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { buildSetupActivities } from "@workflows/setup/activities";

// ---- helpers ----------------------------------------------------------------

/**
 * A NASDAQ equity watch (Mon–Fri 09:30–16:00 ET). Used for the
 * closed-market tests (we supply a Saturday timestamp).
 */
const nasdaqWatch: WatchConfig = {
  id: "aapl-1h",
  enabled: true,
  asset: { symbol: "AAPL", source: "yahoo", quoteType: "EQUITY", exchange: "NMS" },
  timeframes: { primary: "1h", higher: [] },
  schedule: { timezone: "America/New_York" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50,
    score_initial: 25,
    score_threshold_finalizer: 80,
    score_threshold_dead: 10,
    score_max: 100,
    invalidation_policy: "strict" as const,
    min_risk_reward_ratio: 2,
  },
  history_compaction: { max_raw_events_in_context: 40, summarize_after_age_hours: 48 },
  deduplication: { similar_setup_window_candles: 5, similar_price_tolerance_pct: 0.5 },
  pre_filter: {
    enabled: true,
    mode: "lenient",
    thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 },
  },
  analyzers: {
    // biome-ignore lint/suspicious/noExplicitAny: test fake provider
    detector: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
    // biome-ignore lint/suspicious/noExplicitAny: test fake provider
    reviewer: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
    // biome-ignore lint/suspicious/noExplicitAny: test fake provider
    finalizer: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
  },
  optimization: { reviewer_skip_when_detector_corroborated: true, allow_same_tick_fast_path: true },
  costs: { fees_pct: 0.1, slippage_pct: 0.05 },
  notify_on: [],
  include_chart_image: true,
  include_reasoning: true,
  budget: { pause_on_budget_exceeded: true },
  feedback: {
    enabled: false,
    max_active_lessons_per_category: 30,
    injection: { detector: false, reviewer: false, finalizer: false },
    context_providers_disabled: [],
  },
  indicators: {},
};

/**
 * A Binance (always-open) watch. Used for the open-market tests.
 */
const binanceWatch: WatchConfig = {
  id: "btc-1h",
  enabled: true,
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: [] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50,
    score_initial: 25,
    score_threshold_finalizer: 80,
    score_threshold_dead: 10,
    score_max: 100,
    invalidation_policy: "strict" as const,
    min_risk_reward_ratio: 2,
  },
  history_compaction: { max_raw_events_in_context: 40, summarize_after_age_hours: 48 },
  deduplication: { similar_setup_window_candles: 5, similar_price_tolerance_pct: 0.5 },
  pre_filter: {
    enabled: true,
    mode: "lenient",
    thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 },
  },
  analyzers: {
    // biome-ignore lint/suspicious/noExplicitAny: test fake provider
    detector: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
    // biome-ignore lint/suspicious/noExplicitAny: test fake provider
    reviewer: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
    // biome-ignore lint/suspicious/noExplicitAny: test fake provider
    finalizer: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
  },
  optimization: { reviewer_skip_when_detector_corroborated: true, allow_same_tick_fast_path: true },
  costs: { fees_pct: 0.1, slippage_pct: 0.05 },
  notify_on: [],
  include_chart_image: true,
  include_reasoning: true,
  budget: { pause_on_budget_exceeded: true },
  feedback: {
    enabled: false,
    max_active_lessons_per_category: 30,
    injection: { detector: false, reviewer: false, finalizer: false },
    context_providers_disabled: [],
  },
  indicators: {},
};

// A Saturday 12:00 UTC — NASDAQ is always closed on Saturday.
const SATURDAY_UTC = new Date("2026-05-02T12:00:00Z"); // 2026-05-02 is a Saturday

// A Monday 14:00 UTC (09:00 ET) — NASDAQ is NOT open at 09:00 ET (opens 09:30).
// Using a Wednesday midday ET instead to be safely open: 2026-04-29 is a Wednesday.
const WEDNESDAY_MARKET_OPEN_UTC = new Date("2026-04-29T15:00:00Z"); // 11:00 ET

function makeDeps(
  watch: WatchConfig,
  clock: FakeClock,
  llmProvider: FakeLLMProvider,
): ActivityDeps {
  const eventStore = new InMemoryEventStore();
  const setupRepo = new InMemorySetupRepository();
  const tickSnapshotStore = new InMemoryTickSnapshotStore();
  const artifactStore = new InMemoryArtifactStore();

  // Seed a setup row for the "open market" paths to find
  setupRepo.create({
    id: "setup-test",
    watchId: watch.id,
    asset: watch.asset.symbol,
    timeframe: watch.timeframes.primary,
    status: "REVIEWING",
    currentScore: 25,
    patternHint: "double_bottom",
    patternCategory: "accumulation",
    expectedMaturationTicks: null,
    invalidationLevel: 100,
    direction: "LONG",
    ttlCandles: 50,
    ttlExpiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
    workflowId: "wf-test",
  });

  return {
    clock,
    watchById: async (id) => (id === watch.id ? watch : null),
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    llmProviders: new Map([["fake", llmProvider]]),
    llmCallStore: new FakeLLMCallStore(),
    fundingRateProviders: new Map(),
    // The rest are never reached in these tests
    marketDataFetchers: new Map(),
    chartRenderer: null as never,
    indicatorCalculator: null as never,
    indicatorRegistry: null as never,
    promptBuilder: null as never,
    priceFeeds: new Map(),
    notifier: null as never,
    watchRepo: null as never,
    config: null as never,
    infra: null as never,
    temporalClient: null as never,
    scheduleController: null as never,
    db: null as never,
    pgPool: null as never,
    lessonStore: null as never,
    lessonEventStore: null as never,
    feedbackContextRegistry: null as never,
    notifyLessonPending: null as never,
  };
}

// ---- runReviewer tests -------------------------------------------------------

describe("runReviewer — market-hours guard", () => {
  test("closed market (NASDAQ Saturday) → returns skipReason:'market_closed' without calling LLM", async () => {
    const clock = new FakeClock(SATURDAY_UTC);
    const llm = new FakeLLMProvider({ name: "fake" });
    const deps = makeDeps(nasdaqWatch, clock, llm);
    const activities = buildSetupActivities(deps);

    const result = await activities.runReviewer({
      setupId: "setup-test",
      watchId: nasdaqWatch.id,
      tickSnapshotId: "snap-does-not-matter",
    });

    expect(result.skipReason).toBe("market_closed");
    expect(result.eventAlreadyExisted).toBe(false);
    expect(result.verdictJson).toBe("");
    expect(result.costUsd).toBe(0);
    // LLM must NOT have been called
    expect(llm.callCount).toBe(0);
  });

  test("runReviewer — invalid asset metadata (UnsupportedExchangeError) → guard skipped, LLM called", async () => {
    // A yahoo EQUITY watch with an unknown exchange code — getSession() will throw.
    const unknownExchangeWatch: WatchConfig = {
      id: "xyz-1h",
      enabled: true,
      asset: { symbol: "XYZ", source: "yahoo", quoteType: "EQUITY", exchange: "XYZ_UNKNOWN" },
      timeframes: { primary: "1h", higher: [] },
      schedule: { timezone: "America/New_York" },
      candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
      setup_lifecycle: {
        ttl_candles: 50,
        score_initial: 25,
        score_threshold_finalizer: 80,
        score_threshold_dead: 10,
        score_max: 100,
        invalidation_policy: "strict" as const,
        min_risk_reward_ratio: 2,
      },
      history_compaction: { max_raw_events_in_context: 40, summarize_after_age_hours: 48 },
      deduplication: { similar_setup_window_candles: 5, similar_price_tolerance_pct: 0.5 },
      pre_filter: {
        enabled: true,
        mode: "lenient",
        thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 },
      },
      analyzers: {
        // biome-ignore lint/suspicious/noExplicitAny: test fake provider
        detector: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
        // biome-ignore lint/suspicious/noExplicitAny: test fake provider
        reviewer: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
        // biome-ignore lint/suspicious/noExplicitAny: test fake provider
        finalizer: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
      },
      optimization: {
        reviewer_skip_when_detector_corroborated: true,
        allow_same_tick_fast_path: true,
      },
      costs: { fees_pct: 0.1, slippage_pct: 0.05 },
      notify_on: [],
      include_chart_image: true,
      include_reasoning: true,
      budget: { pause_on_budget_exceeded: true },
      feedback: {
        enabled: false,
        max_active_lessons_per_category: 30,
        injection: { detector: false, reviewer: false, finalizer: false },
        context_providers_disabled: [],
      },
      indicators: {},
    };

    const clock = new FakeClock(SATURDAY_UTC);
    const llm = new FakeLLMProvider({ name: "fake" });
    const deps = makeDeps(unknownExchangeWatch, clock, llm);
    const activities = buildSetupActivities(deps);

    // Guard should be skipped (no skipReason) and the activity proceeds to the LLM
    // path. The tick snapshot is missing, so it throws — confirming the guard was bypassed.
    await expect(
      activities.runReviewer({
        setupId: "setup-test",
        watchId: unknownExchangeWatch.id,
        tickSnapshotId: "snap-missing",
      }),
    ).rejects.toThrow("TickSnapshot snap-missing not found");
  });

  test("open market (Binance, always-open) → attempts LLM (tick snapshot lookup fails, confirming LLM path was entered)", async () => {
    const clock = new FakeClock(WEDNESDAY_MARKET_OPEN_UTC);
    const llm = new FakeLLMProvider({ name: "fake" });
    const deps = makeDeps(binanceWatch, clock, llm);
    const activities = buildSetupActivities(deps);

    // The market is open; the activity will proceed past the guard and try to
    // fetch the tick snapshot. Since we did NOT seed one, it throws.
    // That throw confirms the guard was passed (the LLM path was entered).
    await expect(
      activities.runReviewer({
        setupId: "setup-test",
        watchId: binanceWatch.id,
        tickSnapshotId: "snap-missing",
      }),
    ).rejects.toThrow("TickSnapshot snap-missing not found");
  });
});

// ---- runFinalizer tests -----------------------------------------------------

describe("runFinalizer — market-hours guard", () => {
  test("closed market (NASDAQ Saturday) → returns skipReason:'market_closed' without calling LLM", async () => {
    const clock = new FakeClock(SATURDAY_UTC);
    const llm = new FakeLLMProvider({ name: "fake" });
    const deps = makeDeps(nasdaqWatch, clock, llm);
    const activities = buildSetupActivities(deps);

    const result = await activities.runFinalizer({
      setupId: "setup-test",
      watchId: nasdaqWatch.id,
    });

    expect(result.skipReason).toBe("market_closed");
    expect(result.decisionJson).toBe("");
    expect(result.costUsd).toBe(0);
    // LLM must NOT have been called
    expect(llm.callCount).toBe(0);
  });

  test("open market (Binance, always-open) → proceeds past guard (setup lookup completes, LLM path entered)", async () => {
    const clock = new FakeClock(WEDNESDAY_MARKET_OPEN_UTC);
    const llm = new FakeLLMProvider({ name: "fake" });
    const deps = makeDeps(binanceWatch, clock, llm);
    const activities = buildSetupActivities(deps);

    // The market is open; the guard is passed. The activity fetches the setup
    // (seeded), builds the prompt, then calls resolveAndCall. Our FakeLLMProvider
    // does NOT return a valid FinalizerOutputSchema-shaped response, so the
    // schema validation will throw — but that proves the LLM path was entered.
    // (Alternatively, configure a valid response and assert result.decisionJson.)
    //
    // We assert no skipReason is set AND the LLM was called.
    const fakeLlmResponse = JSON.stringify({ go: false, reasoning: "test rejection" });
    llm.setCompleteImpl(async () => ({
      content: fakeLlmResponse,
      parsed: { go: false, reasoning: "test rejection" },
      costUsd: 0.001,
      latencyMs: 10,
      promptTokens: 100,
      completionTokens: 20,
    }));

    const result = await activities.runFinalizer({
      setupId: "setup-test",
      watchId: binanceWatch.id,
    });

    expect(result.skipReason).toBeUndefined();
    expect(llm.callCount).toBe(1);
    expect(JSON.parse(result.decisionJson).go).toBe(false);
  });
});
