import { beforeEach, describe, expect, test } from "bun:test";
import type { WatchConfig, WatchesConfig } from "@domain/schemas/WatchesConfig";
import type { ActivityDeps, NotifyLessonPendingInput } from "@workflows/activityDependencies";
import { buildFeedbackActivities } from "@workflows/feedback/activities";
import { InMemoryLessonEventStore } from "../../fakes/InMemoryLessonEventStore";
import { InMemoryLessonStore } from "../../fakes/InMemoryLessonStore";

const watchId = "btc-1h";
const setupId = "00000000-0000-0000-0000-000000000001";

function makeWatch(): WatchConfig {
  return {
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
      injection: { detector: true, reviewer: true, finalizer: true },
      context_providers_disabled: [],
    },
  };
}

type TestDeps = {
  deps: ActivityDeps;
  lessonStore: InMemoryLessonStore;
  lessonEventStore: InMemoryLessonEventStore;
  captured: NotifyLessonPendingInput[];
};

function buildDeps(): TestDeps {
  const lessonStore = new InMemoryLessonStore();
  const lessonEventStore = new InMemoryLessonEventStore();
  const watch = makeWatch();
  const captured: NotifyLessonPendingInput[] = [];

  // applyLessonChanges only uses watchById, lessonStore, lessonEventStore,
  // and notifyLessonPending — all other fields are placeholders satisfying
  // the structural type without being touched by the activity.
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
    notifyLessonPending: async (i: NotifyLessonPendingInput) => {
      captured.push(i);
    },
  } as unknown as ActivityDeps;

  return { deps, lessonStore, lessonEventStore, captured };
}

describe("applyLessonChanges", () => {
  let h: TestDeps;
  beforeEach(() => {
    h = buildDeps();
  });

  test("CREATE within cap creates a PENDING lesson and notifies", async () => {
    const activities = buildFeedbackActivities(h.deps);

    const result = await activities.applyLessonChanges({
      setupId,
      watchId,
      closeReason: "sl_hit_direct",
      proposedActions: [
        {
          type: "CREATE",
          category: "reviewing",
          title: "Capture stalled momentum after the second leg",
          body: "x".repeat(60),
          rationale: "y".repeat(30),
        },
      ],
      feedbackPromptVersion: "feedback_v1",
      provider: "claude_max",
      model: "claude-opus-4-7",
      inputHash: "test-hash",
      costUsd: 0.3,
      latencyMs: 12_000,
    });

    expect(result.changesApplied).toBe(1);
    expect(result.pendingApprovalsCreated).toBe(1);
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]?.kind).toBe("CREATE");
    const lessons = await h.lessonStore.listByStatus({ watchId, status: "PENDING" });
    expect(lessons).toHaveLength(1);
    const events = await h.lessonEventStore.listForSetup(setupId);
    expect(events.filter((e) => e.type === "CREATE")).toHaveLength(1);
  });

  test("REINFORCE on ACTIVE lesson increments counter, no notification", async () => {
    const lessonId = "11111111-1111-1111-1111-111111111111";
    await h.lessonStore.create({
      id: lessonId,
      watchId,
      category: "reviewing",
      title: "x".repeat(20),
      body: "y".repeat(60),
      rationale: "z".repeat(30),
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    const activities = buildFeedbackActivities(h.deps);

    const result = await activities.applyLessonChanges({
      setupId,
      watchId,
      closeReason: "sl_hit_direct",
      proposedActions: [{ type: "REINFORCE", lessonId, reason: "z".repeat(20) }],
      feedbackPromptVersion: "feedback_v1",
      provider: "claude_max",
      model: "claude-opus-4-7",
      inputHash: "test-hash",
      costUsd: 0,
      latencyMs: 0,
    });

    expect(result.changesApplied).toBe(1);
    expect(result.pendingApprovalsCreated).toBe(0);
    expect(h.captured).toHaveLength(0);
    const after = await h.lessonStore.getById(lessonId);
    expect(after?.timesReinforced).toBe(1);
  });

  test("DEPRECATE moves ACTIVE lesson to DEPRECATED, no notification", async () => {
    const lessonId = "22222222-2222-2222-2222-222222222222";
    await h.lessonStore.create({
      id: lessonId,
      watchId,
      category: "reviewing",
      title: "x".repeat(20),
      body: "y".repeat(60),
      rationale: "z".repeat(30),
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    const activities = buildFeedbackActivities(h.deps);

    await activities.applyLessonChanges({
      setupId,
      watchId,
      closeReason: "sl_hit_direct",
      proposedActions: [{ type: "DEPRECATE", lessonId, reason: "z".repeat(20) }],
      feedbackPromptVersion: "feedback_v1",
      provider: "claude_max",
      model: "claude-opus-4-7",
      inputHash: "test-hash",
      costUsd: 0,
      latencyMs: 0,
    });

    expect(h.captured).toHaveLength(0);
    const after = await h.lessonStore.getById(lessonId);
    expect(after?.status).toBe("DEPRECATED");
    const events = await h.lessonEventStore.listForSetup(setupId);
    expect(events.filter((e) => e.type === "DEPRECATE")).toHaveLength(1);
  });

  test("AutoRejected actions are persisted in lesson_events when cap exceeded", async () => {
    // Pre-fill 30 ACTIVE lessons in the reviewing category to saturate the cap.
    for (let i = 0; i < 30; i++) {
      await h.lessonStore.create({
        id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        watchId,
        category: "reviewing",
        title: `Filler lesson title ${i} for cap-test`,
        body: "x".repeat(60),
        rationale: "y".repeat(30),
        promptVersion: "feedback_v1",
        status: "ACTIVE",
      });
    }
    const activities = buildFeedbackActivities(h.deps);

    const result = await activities.applyLessonChanges({
      setupId,
      watchId,
      closeReason: "sl_hit_direct",
      proposedActions: [
        {
          type: "CREATE",
          category: "reviewing",
          title: "An overflow lesson title for cap test",
          body: "x".repeat(60),
          rationale: "y".repeat(30),
        },
      ],
      feedbackPromptVersion: "feedback_v1",
      provider: "claude_max",
      model: "claude-opus-4-7",
      inputHash: "test-hash",
      costUsd: 0.3,
      latencyMs: 12_000,
    });

    expect(result.changesApplied).toBe(0);
    expect(result.pendingApprovalsCreated).toBe(0);
    expect(h.captured).toHaveLength(0);
    const events = await h.lessonEventStore.listForSetup(setupId);
    const auto = events.filter((e) => e.type === "AutoRejected");
    expect(auto.length).toBe(1);
    if (auto[0]?.payload.type === "AutoRejected") {
      expect(auto[0].payload.data.reason).toBe("cap_exceeded");
    }
  });
});
