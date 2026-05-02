import { describe, expect, test } from "bun:test";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import type { WatchConfig, WatchesConfig } from "@domain/schemas/WatchesConfig";
import { computeFeedbackInputHash } from "@domain/services/feedbackInputHash";
import type { ActivityDeps, NotifyLessonPendingInput } from "@workflows/activityDependencies";
import { buildFeedbackActivities } from "@workflows/feedback/activities";
import { InMemoryLessonEventStore } from "../../fakes/InMemoryLessonEventStore";
import { InMemoryLessonStore } from "../../fakes/InMemoryLessonStore";

const watchId = "btc-1h";

// "fake" provider values key into test-only llmProviders maps.
function makeWatch(): WatchConfig {
  const cfg: unknown = {
    id: watchId,
    enabled: true,
    asset: { symbol: "BTCUSDT", source: "binance" },
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
      thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25, near_pivot_distance_pct: 0.3 },
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
  };
  return cfg as WatchConfig;
}

/**
 * Pre-seed the lesson_events store with a CREATE event whose inputHash matches
 * what `runFeedbackAnalysis` will compute for the given chunkHashes and an
 * empty active-lesson pool. Returns the deps + the inputHash used so callers
 * can assert against it.
 *
 * The activity calls `loadPrompt("feedback")` to obtain the prompt version
 * before hashing, so we do the same here to stay in lockstep.
 */
async function buildDepsWithCachedEvent(args: { chunkHashes: string[] }): Promise<{
  deps: ActivityDeps;
  lessonEventStore: InMemoryLessonEventStore;
  lessonStore: InMemoryLessonStore;
  inputHash: string;
}> {
  const lessonStore = new InMemoryLessonStore();
  const lessonEventStore = new InMemoryLessonEventStore();
  const watch = makeWatch();

  const prompt = await loadPrompt("feedback");
  const inputHash = computeFeedbackInputHash({
    promptVersion: prompt.version,
    contextChunkHashes: args.chunkHashes,
    existingLessonIds: [],
  });

  // Seed a prior CREATE event so the activity's `findByInputHash` returns a hit.
  await lessonEventStore.append({
    watchId,
    lessonId: "prior-lesson-id",
    type: "CREATE",
    actor: prompt.version,
    triggerSetupId: "prior-setup-id",
    triggerCloseReason: "sl_hit_direct",
    payload: {
      type: "CREATE",
      data: {
        category: "reviewing",
        title: "Prior lesson title",
        body: "x".repeat(60),
        rationale: "y".repeat(30),
      },
    },
    provider: "claude_max",
    model: "claude-opus-4-7",
    promptVersion: prompt.version,
    inputHash,
    costUsd: 0.42,
    latencyMs: 12_345,
  });

  // Only the fields runFeedbackAnalysis cache-hit path actually touches:
  // watchById, lessonStore.listActive (returns []), lessonEventStore.findByInputHash.
  // artifactStore + llmProviders are never reached on cache hit, so they
  // remain placeholders satisfying the structural type.
  const deps = {
    marketDataFetchers: new Map(),
    chartRenderer: null,
    indicatorCalculator: null,
    llmProviders: new Map(),
    priceFeeds: new Map(),
    notifier: null,
    setupRepo: null,
    eventStore: null,
    artifactStore: null,
    tickSnapshotStore: null,
    clock: null,
    config: null as unknown as WatchesConfig,
    infra: null,
    watchById: (id: string) => (id === watchId ? watch : undefined),
    temporalClient: null,
    db: null,
    lessonStore,
    lessonEventStore,
    feedbackContextRegistry: null,
    notifyLessonPending: async (_i: NotifyLessonPendingInput) => {},
  } as unknown as ActivityDeps;

  return { deps, lessonEventStore, lessonStore, inputHash };
}

describe("runFeedbackAnalysis idempotence", () => {
  test("same inputHash returns cached result without invoking LLM", async () => {
    const chunkHashes = ["x"];
    const { deps, lessonEventStore, inputHash } = await buildDepsWithCachedEvent({
      chunkHashes,
    });
    const activities = buildFeedbackActivities(deps);

    const before = (await lessonEventStore.findByInputHash({ watchId, inputHash })).length;
    expect(before).toBe(1);

    const result = await activities.runFeedbackAnalysis({
      setupId: "00000000-0000-0000-0000-000000000010",
      watchId,
      // contextRef would be loaded only on cache miss — never read on cache hit,
      // so an unreachable URI is fine here.
      contextRef: "file://does-not-matter.json",
      chunkHashes,
    });

    expect(result.cached).toBe(true);
    expect(result.costUsd).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.inputHash).toBe(inputHash);

    // No new event should have been appended on a cache hit — the activity
    // only reads the prior event, it does not double-persist.
    const after = await lessonEventStore.findByInputHash({ watchId, inputHash });
    expect(after.length).toBe(before);
  });
});
