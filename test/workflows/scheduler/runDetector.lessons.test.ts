import { beforeEach, describe, expect, test } from "bun:test";
import { clearPromptCache } from "@adapters/prompts/loadPrompt";
import type { TickSnapshot } from "@domain/entities/TickSnapshot";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { WatchConfig, WatchesConfig } from "@domain/schemas/WatchesConfig";
import { FakeLLMProvider } from "@test-fakes/FakeLLMProvider";
import { InMemoryArtifactStore } from "@test-fakes/InMemoryArtifactStore";
import { InMemoryLessonStore } from "@test-fakes/InMemoryLessonStore";
import { InMemoryTickSnapshotStore } from "@test-fakes/InMemoryTickSnapshotStore";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { buildSchedulerActivities } from "@workflows/scheduler/activities";

const watchId = "btc-1h";

// "fake" provider/source values key into test-only maps.
function makeWatch(injectionDetector: boolean): WatchConfig {
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
      injection: { detector: injectionDetector, reviewer: true, finalizer: true },
      context_providers_disabled: [],
    },
  };
  return cfg as WatchConfig;
}

type Harness = {
  deps: ActivityDeps;
  lessonStore: InMemoryLessonStore;
  llm: FakeLLMProvider;
  tickSnap: TickSnapshot;
};

async function buildHarness(injectionDetector: boolean): Promise<Harness> {
  const watch = makeWatch(injectionDetector);
  const lessonStore = new InMemoryLessonStore();
  const tickSnapshotStore = new InMemoryTickSnapshotStore();
  const artifactStore = new InMemoryArtifactStore();

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
    ohlcvUri: "mem://ohlcv",
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

  const llm = new FakeLLMProvider({
    name: "fake",
    available: true,
    completeImpl: async () => ({
      content: "{}",
      parsed: { corroborations: [], new_setups: [], ignore_reason: "nothing" },
      costUsd: 0,
      latencyMs: 1,
      promptTokens: 50,
      completionTokens: 25,
    }),
  });
  const llmProviders = new Map<string, LLMProvider>([["fake", llm]]);

  const deps = {
    marketDataFetchers: new Map(),
    chartRenderer: null,
    indicatorCalculator: null,
    llmProviders,
    priceFeeds: new Map(),
    notifier: null,
    setupRepo: null,
    eventStore: null,
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

  return { deps, lessonStore, llm, tickSnap };
}

describe("runDetector activeLessons injection", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  test("includes activeLessons in prompt when injection.detector=true", async () => {
    const h = await buildHarness(true);
    const lessonId = "11111111-1111-1111-1111-111111111111";
    const uniqueTitle = "ZZ-DETECTOR-LESSON-MARKER-AAA";
    await h.lessonStore.create({
      id: lessonId,
      watchId,
      category: "detecting",
      title: uniqueTitle,
      body: "Skip setups with anemic volume even when RSI is extreme.",
      rationale: "Reduces false positives observed in past failed trades.",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });

    const activities = buildSchedulerActivities(h.deps);
    await activities.runDetector({
      watchId,
      tickSnapshotId: h.tickSnap.id,
      aliveSetups: [],
    });

    expect(h.llm.callsLog).toHaveLength(1);
    const userPrompt = h.llm.callsLog[0]?.userPrompt ?? "";
    expect(userPrompt).toContain(uniqueTitle);

    const after = await h.lessonStore.getById(lessonId);
    expect(after?.timesUsedInPrompts).toBe(1);
  });

  test("excludes activeLessons when injection.detector=false", async () => {
    const h = await buildHarness(false);
    const uniqueTitle = "ZZ-DETECTOR-LESSON-MARKER-BBB";
    await h.lessonStore.create({
      id: "22222222-2222-2222-2222-222222222222",
      watchId,
      category: "detecting",
      title: uniqueTitle,
      body: "Body that must NOT appear in prompt.",
      rationale: "rationale",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });

    const activities = buildSchedulerActivities(h.deps);
    await activities.runDetector({
      watchId,
      tickSnapshotId: h.tickSnap.id,
      aliveSetups: [],
    });

    expect(h.llm.callsLog).toHaveLength(1);
    const userPrompt = h.llm.callsLog[0]?.userPrompt ?? "";
    expect(userPrompt).not.toContain(uniqueTitle);
  });
});
