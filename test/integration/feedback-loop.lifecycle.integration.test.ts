import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedbackContextProviderRegistry } from "@adapters/feedback-context/FeedbackContextProviderRegistry";
import { FilesystemArtifactStore } from "@adapters/persistence/FilesystemArtifactStore";
import { PostgresEventStore } from "@adapters/persistence/PostgresEventStore";
import { PostgresLessonEventStore } from "@adapters/persistence/PostgresLessonEventStore";
import { PostgresLessonStore } from "@adapters/persistence/PostgresLessonStore";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
import { PostgresTickSnapshotStore } from "@adapters/persistence/PostgresTickSnapshotStore";
import { lessonEvents, lessons } from "@adapters/persistence/schema";
import { SystemClock } from "@adapters/time/SystemClock";
import { buildLessonApprovalUseCase } from "@domain/feedback/lessonApprovalUseCase";
import { parseTimeframeToMs } from "@domain/ports/Clock";
import type { LessonStore } from "@domain/ports/LessonStore";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { FeedbackOutput } from "@domain/schemas/FeedbackOutput";
import type { WatchConfig, WatchesConfig } from "@domain/schemas/WatchesConfig";
import { FakeChartRenderer } from "@test-fakes/FakeChartRenderer";
import { FakeFeedbackContextProvider } from "@test-fakes/FakeFeedbackContextProvider";
import { FakeIndicatorCalculator } from "@test-fakes/FakeIndicatorCalculator";
import { FakeLLMProvider } from "@test-fakes/FakeLLMProvider";
import { FakeMarketDataFetcher } from "@test-fakes/FakeMarketDataFetcher";
import { FakeNotifier } from "@test-fakes/FakeNotifier";
import { FakePriceFeed } from "@test-fakes/FakePriceFeed";
import { startTestPostgres, type TestPostgres } from "@test-helpers/postgres";
import type { ActivityDeps, NotifyLessonPendingInput } from "@workflows/activityDependencies";
import { buildFeedbackActivities } from "@workflows/feedback/activities";
import { and, eq } from "drizzle-orm";

let tp: TestPostgres;
let baseDir: string;

// "fake" provider/source values are intentional — they key into the test-only
// llmProviders / marketDataFetchers maps. Cast away the strict schema enums
// for those fields so we don't pollute production types with a "fake" branch.
function makeWatch(id: string): WatchConfig {
  const cfg: unknown = {
    id,
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
    notify_on: ["confirmed", "rejected", "tp_hit", "sl_hit", "invalidated_after_confirmed"],
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

const infra = {
  database: { url: "x", pool_size: 1, ssl: false },
  temporal: {
    address: "x",
    namespace: "default",
    task_queues: { scheduler: "s", analysis: "a", notifications: "n" },
  },
  notifications: { telegram: { bot_token: "t", chat_id: "c" } },
  llm: { openrouter_api_key: null },
  artifacts: { base_dir: "/tmp" },
  claude: { workspace_dir: "/tmp" },
};

beforeAll(async () => {
  tp = await startTestPostgres();
  baseDir = await mkdtemp(join(tmpdir(), "tf-fb-lc-"));
}, 120_000);

afterAll(async () => {
  await tp?.cleanup();
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

function buildDepsForWatch(args: {
  watch: WatchConfig;
  feedbackOutput: FeedbackOutput;
  notifyCapture: NotifyLessonPendingInput[];
}): ActivityDeps {
  const tickSnapshotStore = new PostgresTickSnapshotStore(tp.db);
  const setupRepo = new PostgresSetupRepository(tp.db, parseTimeframeToMs);
  const eventStore = new PostgresEventStore(tp.db);
  const artifactStore = new FilesystemArtifactStore(tp.db, baseDir);
  const lessonStore = new PostgresLessonStore(tp.db);
  const lessonEventStore = new PostgresLessonEventStore(tp.db);

  const llmProviders = new Map<string, LLMProvider>();
  llmProviders.set(
    "fake",
    new FakeLLMProvider({
      name: "fake",
      completeImpl: async () => ({
        content: JSON.stringify(args.feedbackOutput),
        parsed: args.feedbackOutput,
        costUsd: 0.01,
        latencyMs: 5,
        promptTokens: 100,
        completionTokens: 50,
      }),
    }),
  );

  const fakeProvider = new FakeFeedbackContextProvider("setup-events", [
    {
      providerId: "setup-events",
      title: "fake context",
      content: { kind: "markdown", value: "synthetic feedback context" },
    },
  ]);
  const feedbackContextRegistry = new FeedbackContextProviderRegistry({
    "setup-events": fakeProvider,
  });

  const config: WatchesConfig = {
    version: 1,
    market_data: ["binance"],
    llm_providers: {},
    artifacts: { type: "filesystem", retention: { keep_days: 30, keep_for_active_setups: true } },
    notifications: { telegram: false },
    watches: [args.watch],
  };

  return {
    marketDataFetchers: new Map([["binance", new FakeMarketDataFetcher()]]),
    chartRenderer: new FakeChartRenderer(),
    indicatorCalculator: new FakeIndicatorCalculator(),
    llmProviders,
    priceFeeds: new Map([["fake", new FakePriceFeed()]]),
    notifier: new FakeNotifier(),
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock: new SystemClock(),
    config,
    infra,
    watchById: (id) => (id === args.watch.id ? args.watch : undefined),
    temporalClient: null as unknown as ActivityDeps["temporalClient"],
    db: tp.db,
    pgPool: tp.pool,
    lessonStore,
    lessonEventStore,
    feedbackContextRegistry,
    notifyLessonPending: async (input) => {
      args.notifyCapture.push(input);
    },
  };
}

async function seedClosedSetup(deps: ActivityDeps, watchId: string): Promise<string> {
  const setupId = crypto.randomUUID();
  await deps.setupRepo.create({
    id: setupId,
    watchId,
    asset: "BTCUSDT",
    timeframe: "1h",
    status: "TRACKING",
    currentScore: 85,
    patternHint: "double_bottom",
    invalidationLevel: 95,
    direction: "LONG",
    ttlCandles: 50,
    ttlExpiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
    workflowId: `setup-${setupId}`,
  });
  await deps.eventStore.append(
    {
      setupId,
      sequence: 0,
      stage: "system",
      actor: "test",
      type: "Confirmed" as never,
      scoreDelta: 0,
      scoreAfter: 85,
      statusBefore: "FINALIZING" as never,
      statusAfter: "TRACKING" as never,
      payload: {
        type: "Confirmed",
        data: { entry: 100, stop_loss: 95, take_profit: [110, 120], reasoning: "GO" },
      } as never,
    },
    { score: 85, status: "TRACKING" as never },
  );
  await deps.eventStore.append(
    {
      setupId,
      sequence: 0,
      stage: "system",
      actor: "test",
      type: "SLHit" as never,
      scoreDelta: 0,
      scoreAfter: 85,
      statusBefore: "TRACKING" as never,
      statusAfter: "CLOSED" as never,
      payload: {
        type: "SLHit",
        data: { price: 90, observedAt: new Date().toISOString() },
      } as never,
    },
    { score: 85, status: "CLOSED" as never },
  );
  await deps.setupRepo.markClosed(setupId, "CLOSED");
  return setupId;
}

async function preSeedActiveLesson(
  store: LessonStore,
  watchId: string,
  opts: { pinned?: boolean } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await store.create({
    id,
    watchId,
    category: "reviewing",
    title: "Be cautious of late breakouts after extended ranges",
    body: "Extended consolidation ranges that finally break tend to fade quickly. Require a follow-through close before issuing a STRENGTHEN of significant magnitude.",
    rationale: "Pre-seeded for lifecycle test.",
    promptVersion: "feedback_v1",
    sourceFeedbackEventId: null,
    status: "ACTIVE",
  });
  if (opts.pinned) {
    await store.setPinned(id, true);
  }
  return id;
}

async function runFeedbackPipeline(
  deps: ActivityDeps,
  setupId: string,
  watchId: string,
): Promise<void> {
  const fb = buildFeedbackActivities(deps);
  const gather = await fb.gatherFeedbackContext({
    setupId,
    watchId,
    closeOutcome: { reason: "sl_hit_direct", everConfirmed: true },
  });
  const analysis = await fb.runFeedbackAnalysis({
    setupId,
    watchId,
    contextRef: gather.contextRef,
    chunkHashes: gather.chunkHashes,
  });
  await fb.applyLessonChanges({
    setupId,
    watchId,
    closeReason: "sl_hit_direct",
    proposedActions: analysis.actions,
    feedbackPromptVersion: analysis.promptVersion,
    provider: analysis.provider,
    model: analysis.model,
    inputHash: analysis.inputHash,
    costUsd: analysis.costUsd,
    latencyMs: analysis.latencyMs,
  });
}

describe("feedback loop lifecycle scenarios", () => {
  test("REINFORCE: same inputHash family — counter increments, no notification", async () => {
    const watchId = "lc-reinforce";
    const watch = makeWatch(watchId);
    const notifyCapture: NotifyLessonPendingInput[] = [];

    // First create a deps just to seed an ACTIVE lesson.
    const seedDeps = buildDepsForWatch({
      watch,
      feedbackOutput: { summary: "init", actions: [] } as unknown as FeedbackOutput,
      notifyCapture,
    });
    const lessonId = await preSeedActiveLesson(seedDeps.lessonStore, watchId);

    const setupId = await seedClosedSetup(seedDeps, watchId);

    const deps = buildDepsForWatch({
      watch,
      feedbackOutput: {
        summary:
          "Same kind of failure as the existing lesson predicted — reinforces the active lesson without changes.",
        actions: [
          {
            type: "REINFORCE",
            lessonId,
            reason: "Same failure pattern observed: late break followed by quick fade.",
          },
        ],
      },
      notifyCapture,
    });

    await runFeedbackPipeline(deps, setupId, watchId);

    const [updated] = await tp.db.select().from(lessons).where(eq(lessons.id, lessonId));
    expect(updated?.timesReinforced).toBe(1);
    expect(notifyCapture.length).toBe(0);

    const evts = await tp.db
      .select()
      .from(lessonEvents)
      .where(and(eq(lessonEvents.watchId, watchId), eq(lessonEvents.type, "NotificationSent")));
    expect(evts.length).toBe(0);
  }, 60_000);

  test("REFINE: PENDING lesson supersedes ACTIVE; on approve, supersedes is ARCHIVED", async () => {
    const watchId = "lc-refine";
    const watch = makeWatch(watchId);
    const notifyCapture: NotifyLessonPendingInput[] = [];

    const seedDeps = buildDepsForWatch({
      watch,
      feedbackOutput: { summary: "init", actions: [] } as unknown as FeedbackOutput,
      notifyCapture,
    });
    const oldLessonId = await preSeedActiveLesson(seedDeps.lessonStore, watchId);
    const setupId = await seedClosedSetup(seedDeps, watchId);

    const deps = buildDepsForWatch({
      watch,
      feedbackOutput: {
        summary:
          "The lesson partially captured the failure mode but is too narrow. A refined version is needed.",
        actions: [
          {
            type: "REFINE",
            lessonId: oldLessonId,
            newTitle: "Require follow-through close on range expansions before strengthening",
            newBody:
              "After a prolonged consolidation finally breaks, do not issue STRENGTHEN until at least one full candle closes beyond the breakout level with sustained volume.",
            rationale: "Refines the existing lesson with explicit follow-through criteria.",
          },
        ],
      },
      notifyCapture,
    });

    await runFeedbackPipeline(deps, setupId, watchId);

    // After applyLessonChanges: new lesson PENDING, old still ACTIVE.
    const newRows = await tp.db
      .select()
      .from(lessons)
      .where(and(eq(lessons.watchId, watchId), eq(lessons.status, "PENDING")));
    expect(newRows.length).toBe(1);
    const newLessonId = newRows[0]?.id;
    expect(newRows[0]?.supersedesLessonId).toBe(oldLessonId);

    const [oldStill] = await tp.db.select().from(lessons).where(eq(lessons.id, oldLessonId));
    expect(oldStill?.status).toBe("ACTIVE");

    expect(notifyCapture.length).toBe(1);
    expect(notifyCapture[0]?.kind).toBe("REFINE");

    // Approve via use case → new becomes ACTIVE, old becomes ARCHIVED.
    const approval = buildLessonApprovalUseCase({
      lessonStore: deps.lessonStore,
      lessonEventStore: deps.lessonEventStore,
      editLessonMessage: async () => {},
      chatId: "test",
      notificationMsgIdByLessonId: async () => null,
      clock: deps.clock,
    });
    const r = await approval.handle({ action: "approve", lessonId: newLessonId, via: "telegram" });
    expect(r.updated).toBe(true);
    expect(r.finalStatus).toBe("ACTIVE");

    const [refreshNew] = await tp.db.select().from(lessons).where(eq(lessons.id, newLessonId));
    const [refreshOld] = await tp.db.select().from(lessons).where(eq(lessons.id, oldLessonId));
    expect(refreshNew?.status).toBe("ACTIVE");
    expect(refreshOld?.status).toBe("ARCHIVED");
  }, 60_000);

  test("DEPRECATE: ACTIVE → DEPRECATED, no notification", async () => {
    const watchId = "lc-deprecate";
    const watch = makeWatch(watchId);
    const notifyCapture: NotifyLessonPendingInput[] = [];

    const seedDeps = buildDepsForWatch({
      watch,
      feedbackOutput: { summary: "init", actions: [] } as unknown as FeedbackOutput,
      notifyCapture,
    });
    const lessonId = await preSeedActiveLesson(seedDeps.lessonStore, watchId);
    const setupId = await seedClosedSetup(seedDeps, watchId);

    const deps = buildDepsForWatch({
      watch,
      feedbackOutput: {
        summary:
          "The lesson no longer applies — market regime has shifted and the rule is causing false negatives.",
        actions: [
          {
            type: "DEPRECATE",
            lessonId,
            reason: "Regime change makes the lesson stale; deprecating to clear pool slot.",
          },
        ],
      },
      notifyCapture,
    });

    await runFeedbackPipeline(deps, setupId, watchId);

    const [updated] = await tp.db.select().from(lessons).where(eq(lessons.id, lessonId));
    expect(updated?.status).toBe("DEPRECATED");
    expect(notifyCapture.length).toBe(0);
  }, 60_000);

  test("Pinned lesson: REFINE auto-rejected (AutoRejected event)", async () => {
    const watchId = "lc-pinned";
    const watch = makeWatch(watchId);
    const notifyCapture: NotifyLessonPendingInput[] = [];

    const seedDeps = buildDepsForWatch({
      watch,
      feedbackOutput: { summary: "init", actions: [] } as unknown as FeedbackOutput,
      notifyCapture,
    });
    const pinnedLessonId = await preSeedActiveLesson(seedDeps.lessonStore, watchId, {
      pinned: true,
    });
    const setupId = await seedClosedSetup(seedDeps, watchId);

    const deps = buildDepsForWatch({
      watch,
      feedbackOutput: {
        summary:
          "Attempting to refine the pinned lesson — should be auto-rejected by validateActions.",
        actions: [
          {
            type: "REFINE",
            lessonId: pinnedLessonId,
            newTitle: "An attempted refinement of a pinned lesson",
            newBody:
              "This refinement should never be applied because the existing lesson is pinned by the operator and is protected from automated mutation.",
            rationale: "Test: pinned lessons must reject REFINE proposals.",
          },
        ],
      },
      notifyCapture,
    });

    await runFeedbackPipeline(deps, setupId, watchId);

    // Pinned lesson unchanged.
    const [unchanged] = await tp.db.select().from(lessons).where(eq(lessons.id, pinnedLessonId));
    expect(unchanged?.status).toBe("ACTIVE");
    expect(unchanged?.pinned).toBe(true);

    // Exactly one AutoRejected event with reason pinned_lesson.
    const rejected = await tp.db
      .select()
      .from(lessonEvents)
      .where(and(eq(lessonEvents.watchId, watchId), eq(lessonEvents.type, "AutoRejected")));
    expect(rejected.length).toBe(1);
    const payload = rejected[0]?.payload as {
      type: string;
      data?: { reason?: string };
    };
    expect(payload.data?.reason).toBe("pinned_lesson");

    expect(notifyCapture.length).toBe(0);
  }, 60_000);
});
