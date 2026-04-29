import { beforeEach, describe, expect, test } from "bun:test";
import { clearPromptCache } from "@adapters/prompts/loadPrompt";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { WatchConfig, WatchesConfig } from "@domain/schemas/WatchesConfig";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { buildSetupActivities } from "@workflows/setup/activities";
import { FakeLLMProvider } from "@test-fakes/FakeLLMProvider";
import { InMemoryArtifactStore } from "@test-fakes/InMemoryArtifactStore";
import { InMemoryEventStore } from "@test-fakes/InMemoryEventStore";
import { InMemoryLessonStore } from "@test-fakes/InMemoryLessonStore";
import { InMemorySetupRepository } from "@test-fakes/InMemorySetupRepository";
import { InMemoryTickSnapshotStore } from "@test-fakes/InMemoryTickSnapshotStore";

const watchId = "btc-1h";
const setupId = "00000000-0000-0000-0000-000000000111";

function makeWatch(injection: { reviewer: boolean; finalizer: boolean }): WatchConfig {
  return {
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
      thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 },
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
      injection: { detector: true, reviewer: injection.reviewer, finalizer: injection.finalizer },
      context_providers_disabled: [],
    },
  };
}

type Harness = {
  deps: ActivityDeps;
  lessonStore: InMemoryLessonStore;
  reviewerLLM: FakeLLMProvider;
  finalizerLLM: FakeLLMProvider;
  tickSnapshotId: string;
};

async function buildHarness(injection: {
  reviewer: boolean;
  finalizer: boolean;
}): Promise<Harness> {
  const watch = makeWatch(injection);
  const lessonStore = new InMemoryLessonStore();
  const tickSnapshotStore = new InMemoryTickSnapshotStore();
  const artifactStore = new InMemoryArtifactStore();
  const setupRepo = new InMemorySetupRepository();
  const eventStore = new InMemoryEventStore();

  const ohlcv = await artifactStore.put({
    kind: "ohlcv_snapshot",
    content: Buffer.from("[]"),
    mimeType: "application/json",
  });
  const chart = await artifactStore.put({
    kind: "chart_image",
    content: Buffer.from("png"),
    mimeType: "image/png",
  });
  const tickSnap = await tickSnapshotStore.create({
    watchId,
    tickAt: new Date("2026-04-29T00:00:00Z"),
    asset: "BTCUSDT",
    timeframe: "1h",
    ohlcvUri: ohlcv.uri,
    chartUri: chart.uri,
    indicators: {
      rsi: 50,
      ema20: 100,
      ema50: 100,
      ema200: 100,
      atr: 1,
      atrMa20: 1,
      volumeMa20: 100,
      lastVolume: 100,
      recentHigh: 110,
      recentLow: 90,
    },
    preFilterPass: true,
  });

  await setupRepo.create({
    id: setupId,
    watchId,
    asset: "BTCUSDT",
    timeframe: "1h",
    status: "REVIEWING",
    currentScore: 25,
    patternHint: "double_bottom",
    invalidationLevel: 95,
    direction: "LONG",
    ttlCandles: 50,
    ttlExpiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
    workflowId: `setup-${setupId}`,
  });

  // Discriminate reviewer vs finalizer via systemPrompt content.
  const reviewerLLM = new FakeLLMProvider({
    name: "fake",
    available: true,
    completeImpl: async (input) => {
      if (input.systemPrompt.includes("Finalizer")) {
        return {
          content: "{}",
          parsed: {
            go: false,
            reasoning: "no",
            entry: 100,
            stop_loss: 95,
            take_profit: [],
          },
          costUsd: 0,
          latencyMs: 1,
          promptTokens: 50,
          completionTokens: 25,
        };
      }
      return {
        content: "{}",
        parsed: { type: "NEUTRAL", observations: [] },
        costUsd: 0,
        latencyMs: 1,
        promptTokens: 50,
        completionTokens: 25,
      };
    },
  });
  // Single LLM serves both — alias for clarity in assertions.
  const finalizerLLM = reviewerLLM;

  const llmProviders = new Map<string, LLMProvider>([["fake", reviewerLLM]]);

  const deps = {
    marketDataFetchers: new Map(),
    chartRenderer: null,
    indicatorCalculator: null,
    llmProviders,
    priceFeeds: new Map(),
    notifier: null,
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock: null,
    config: null as unknown as WatchesConfig,
    infra: null,
    watchById: (id: string) => (id === watchId ? watch : undefined),
    temporalClient: null,
    db: null,
    lessonStore,
    lessonEventStore: null,
    feedbackContextRegistry: null,
    notifyLessonPending: async () => {},
  } as unknown as ActivityDeps;

  return { deps, lessonStore, reviewerLLM, finalizerLLM, tickSnapshotId: tickSnap.id };
}

describe("runReviewer activeLessons injection", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  test("includes activeLessons in prompt when injection.reviewer=true", async () => {
    const h = await buildHarness({ reviewer: true, finalizer: true });
    const uniqueTitle = "ZZ-REVIEWER-LESSON-MARKER-AAA";
    const lessonId = "33333333-3333-3333-3333-333333333333";
    await h.lessonStore.create({
      id: lessonId,
      watchId,
      category: "reviewing",
      title: uniqueTitle,
      body: "Body to require strong volume confirmation before strengthening.",
      rationale: "Past reviewer over-strengthening on weak volume.",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });

    const activities = buildSetupActivities(h.deps);
    const result = await activities.runReviewer({
      setupId,
      tickSnapshotId: h.tickSnapshotId,
      watchId,
    });

    expect(h.reviewerLLM.callsLog).toHaveLength(1);
    const userPrompt = h.reviewerLLM.callsLog[0]?.userPrompt ?? "";
    expect(userPrompt).toContain(uniqueTitle);

    const after = await h.lessonStore.getById(lessonId);
    expect(after?.timesUsedInPrompts).toBe(1);

    // inputHash MUST include lesson IDs — different from a no-lessons hash.
    expect(result.inputHash).toBeTruthy();
  });

  test("excludes activeLessons when injection.reviewer=false", async () => {
    const h = await buildHarness({ reviewer: false, finalizer: true });
    const uniqueTitle = "ZZ-REVIEWER-LESSON-MARKER-BBB";
    await h.lessonStore.create({
      id: "44444444-4444-4444-4444-444444444444",
      watchId,
      category: "reviewing",
      title: uniqueTitle,
      body: "Body that must NOT appear.",
      rationale: "rationale",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });

    const activities = buildSetupActivities(h.deps);
    await activities.runReviewer({
      setupId,
      tickSnapshotId: h.tickSnapshotId,
      watchId,
    });

    expect(h.reviewerLLM.callsLog).toHaveLength(1);
    const userPrompt = h.reviewerLLM.callsLog[0]?.userPrompt ?? "";
    expect(userPrompt).not.toContain(uniqueTitle);
  });
});

describe("runFinalizer activeLessons injection", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  test("includes activeLessons in prompt when injection.finalizer=true", async () => {
    const h = await buildHarness({ reviewer: true, finalizer: true });
    const uniqueTitle = "ZZ-FINALIZER-LESSON-MARKER-AAA";
    const lessonId = "55555555-5555-5555-5555-555555555555";
    await h.lessonStore.create({
      id: lessonId,
      watchId,
      category: "finalizing",
      title: uniqueTitle,
      body: "Body to refuse GO when volume is anemic.",
      rationale: "Past finalizer false GOs.",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });

    const activities = buildSetupActivities(h.deps);
    await activities.runFinalizer({ setupId, watchId });

    expect(h.finalizerLLM.callsLog).toHaveLength(1);
    const userPrompt = h.finalizerLLM.callsLog[0]?.userPrompt ?? "";
    expect(userPrompt).toContain(uniqueTitle);

    const after = await h.lessonStore.getById(lessonId);
    expect(after?.timesUsedInPrompts).toBe(1);
  });

  test("excludes activeLessons when injection.finalizer=false", async () => {
    const h = await buildHarness({ reviewer: true, finalizer: false });
    const uniqueTitle = "ZZ-FINALIZER-LESSON-MARKER-BBB";
    await h.lessonStore.create({
      id: "66666666-6666-6666-6666-666666666666",
      watchId,
      category: "finalizing",
      title: uniqueTitle,
      body: "Body that must NOT appear.",
      rationale: "rationale",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });

    const activities = buildSetupActivities(h.deps);
    await activities.runFinalizer({ setupId, watchId });

    expect(h.finalizerLLM.callsLog).toHaveLength(1);
    const userPrompt = h.finalizerLLM.callsLog[0]?.userPrompt ?? "";
    expect(userPrompt).not.toContain(uniqueTitle);
  });
});
