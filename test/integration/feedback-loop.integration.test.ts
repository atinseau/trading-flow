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
import type { LLMOutput, LLMProvider } from "@domain/ports/LLMProvider";
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
import { buildSetupActivities } from "@workflows/setup/activities";
import { eq } from "drizzle-orm";

let tp: TestPostgres;
let baseDir: string;

const watchId = "btc-1h";
// "fake" provider/source values are intentional — they key into the test-only
// llmProviders / marketDataFetchers maps below. Cast away the strict schema
// enums for those fields so we don't pollute production types with a "fake"
// branch.
const testWatch = {
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
} as unknown as WatchConfig;

const testConfig: WatchesConfig = {
  version: 1,
  market_data: ["binance"],
  llm_providers: {},
  artifacts: { type: "filesystem", retention: { keep_days: 30, keep_for_active_setups: true } },
  notifications: { telegram: false },
  watches: [testWatch],
};

const infra = {
  database: { url: "x", pool_size: 1, ssl: false },
  temporal: {
    address: "x",
    namespace: "default",
    task_queues: { scheduler: "s", analysis: "a", notifications: "n" },
  },
  notifications: { telegram: { bot_token: "test-token", chat_id: "test-chat" } },
  llm: { openrouter_api_key: null },
  artifacts: { base_dir: "/tmp" },
  claude: { workspace_dir: "/tmp" },
};

beforeAll(async () => {
  tp = await startTestPostgres();
  baseDir = await mkdtemp(join(tmpdir(), "tf-fb-int-"));
}, 120_000);

afterAll(async () => {
  await tp?.cleanup();
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

/**
 * LLM provider that always returns the same FeedbackOutput (only used by
 * `runFeedbackAnalysis`, which uses `provider: "fake"`).
 */
function makeFeedbackLLM(output: FeedbackOutput): LLMProvider {
  return new FakeLLMProvider({
    name: "fake",
    completeImpl: async (): Promise<LLMOutput> => ({
      content: JSON.stringify(output),
      parsed: output,
      costUsd: 0.01,
      latencyMs: 5,
      promptTokens: 100,
      completionTokens: 50,
    }),
  });
}

function buildDeps(args: {
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
  llmProviders.set("fake", makeFeedbackLLM(args.feedbackOutput));

  const fakeProvider = new FakeFeedbackContextProvider("setup-events", [
    {
      providerId: "setup-events",
      title: "fake context",
      content: { kind: "markdown", value: "synthetic feedback context for tests" },
    },
  ]);
  // Map keys must match canonical order ids; use "setup-events" so the
  // registry picks it up with default `context_providers_disabled = []`.
  const feedbackContextRegistry = new FeedbackContextProviderRegistry({
    "setup-events": fakeProvider,
  });

  return {
    marketDataFetchers: new Map([["binance", new FakeMarketDataFetcher()]]),
    chartRenderer: new FakeChartRenderer(),
    indicatorCalculator: new FakeIndicatorCalculator(),
    indicatorRegistry: null as unknown as ActivityDeps["indicatorRegistry"],
    promptBuilder: null as unknown as ActivityDeps["promptBuilder"],
    llmProviders,
    priceFeeds: new Map([["fake", new FakePriceFeed()]]),
    notifier: new FakeNotifier(),
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock: new SystemClock(),
    config: testConfig,
    infra,
    watchRepo: null as unknown as ActivityDeps["watchRepo"],
    scheduleController: null as unknown as ActivityDeps["scheduleController"],
    watchById: async (id) => (id === watchId ? testWatch : null),
    temporalClient: null as unknown as ActivityDeps["temporalClient"],
    db: tp.db,
    pgPool: tp.pool,
    lessonStore,
    lessonEventStore,
    feedbackContextRegistry,
    notifyLessonPending: async (input) => {
      args.notifyCapture.push(input);
      // Persist a NotificationSent event for the lesson — mirrors what the
      // production wiring (Telegram notifier) does after sending.
      await lessonEventStore.append({
        watchId: input.watchId,
        lessonId: input.lessonId,
        type: "NotificationSent",
        actor: "system",
        payload: { type: "NotificationSent", data: { channel: "telegram", msgId: 1 } },
      });
    },
  };
}

async function seedSetupConfirmedThenSLHit(setupId: string, deps: ActivityDeps) {
  const setupActivities = buildSetupActivities(deps);
  // Create the setup row.
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

  // Persist a minimal trajectory: SetupCreated → Strengthened → Confirmed → SLHit.
  // We use persistEvent which writes via PostgresEventStore (transactional + atomic seq).
  const persist = async (e: {
    type: string;
    statusBefore: string;
    statusAfter: string;
    scoreDelta: number;
    scoreAfter: number;
    payload: unknown;
  }) => {
    await setupActivities.persistEvent({
      event: {
        setupId,
        sequence: 0, // ignored; computed atomically by the store
        stage: "system",
        actor: "test",
        type: e.type as never,
        scoreDelta: e.scoreDelta,
        scoreAfter: e.scoreAfter,
        statusBefore: e.statusBefore as never,
        statusAfter: e.statusAfter as never,
        payload: e.payload as never,
      },
      setupUpdate: { score: e.scoreAfter, status: e.statusAfter as never },
    });
  };
  await persist({
    type: "SetupCreated",
    statusBefore: "REVIEWING",
    statusAfter: "REVIEWING",
    scoreDelta: 25,
    scoreAfter: 25,
    payload: { type: "SetupCreated", data: { pattern: "double_bottom" } },
  });
  await persist({
    type: "Strengthened",
    statusBefore: "REVIEWING",
    statusAfter: "FINALIZING",
    scoreDelta: 60,
    scoreAfter: 85,
    payload: { type: "Strengthened", data: { reasoning: "very bullish" } },
  });
  await persist({
    type: "Confirmed",
    statusBefore: "FINALIZING",
    statusAfter: "TRACKING",
    scoreDelta: 0,
    scoreAfter: 85,
    payload: {
      type: "Confirmed",
      data: { entry: 100, stop_loss: 95, take_profit: [110, 120], reasoning: "GO" },
    },
  });
  await persist({
    type: "SLHit",
    statusBefore: "TRACKING",
    statusAfter: "CLOSED",
    scoreDelta: 0,
    scoreAfter: 85,
    payload: {
      type: "SLHit",
      data: { price: 90, observedAt: new Date().toISOString() },
    },
  });
  await deps.setupRepo.markClosed(setupId, "CLOSED");
}

describe("feedback loop integration (full pipeline, real Postgres, fake LLM)", () => {
  test("Confirmed → SLHit triggers feedback loop, creates PENDING lesson, approve via callback → ACTIVE", async () => {
    const setupId = crypto.randomUUID();
    const notifyCapture: NotifyLessonPendingInput[] = [];

    const feedbackOutput: FeedbackOutput = {
      summary:
        "The trade hit SL after confirmation. The reviewer over-weighted bullish observations from the immediate context without checking macro structure.",
      actions: [
        {
          type: "CREATE",
          category: "reviewing",
          title: "Confirm structural confluence before strengthening on momentum alone",
          body: "When momentum-style observations push a setup near the finalizer threshold, require an additional structural confluence check (range high reclaim, divergence, or higher-timeframe trend) before issuing STRENGTHEN of large magnitude.",
          rationale:
            "Setups that close as SL hits often had high score but weak structural backing.",
        },
      ],
    };

    const deps = buildDeps({ feedbackOutput, notifyCapture });

    await seedSetupConfirmedThenSLHit(setupId, deps);

    // Run feedback activities directly (bypass Temporal — child workflow is
    // already covered in test/workflows/feedback/feedbackLoopWorkflow.test.ts).
    const fb = buildFeedbackActivities(deps);

    const gather = await fb.gatherFeedbackContext({
      setupId,
      watchId,
      closeOutcome: { reason: "sl_hit_direct", everConfirmed: true },
    });
    expect(gather.contextRef).toMatch(/^file:/);
    expect(gather.chunkHashes.length).toBeGreaterThan(0);

    const analysis = await fb.runFeedbackAnalysis({
      setupId,
      watchId,
      contextRef: gather.contextRef,
      chunkHashes: gather.chunkHashes,
    });
    expect(analysis.cached).toBe(false);
    expect(analysis.actions.length).toBe(1);

    const apply = await fb.applyLessonChanges({
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
    expect(apply.changesApplied).toBe(1);
    expect(apply.pendingApprovalsCreated).toBe(1);

    // Lesson PENDING.
    const lessonRows = await tp.db.select().from(lessons).where(eq(lessons.watchId, watchId));
    expect(lessonRows.length).toBe(1);
    const created = lessonRows[0];
    expect(created?.status).toBe("PENDING");
    expect(created?.category).toBe("reviewing");

    // CREATE lesson_event with sequence=1 + NotificationSent event captured.
    const evts = await tp.db
      .select()
      .from(lessonEvents)
      .where(eq(lessonEvents.watchId, watchId))
      .orderBy(lessonEvents.sequence);
    expect(evts.length).toBeGreaterThanOrEqual(2);
    expect(evts[0]?.type).toBe("CREATE");
    expect(evts[0]?.sequence).toBe(1);
    expect(evts.some((e) => e.type === "NotificationSent")).toBe(true);
    expect(notifyCapture.length).toBe(1);
    expect(notifyCapture[0]?.kind).toBe("CREATE");

    // Approve via fake callback → ACTIVE.
    const approval = buildLessonApprovalUseCase({
      lessonStore: deps.lessonStore,
      lessonEventStore: deps.lessonEventStore,
      editLessonMessage: async () => {},
      chatId: "test",
      notificationMsgIdByLessonId: async () => null,
      clock: deps.clock,
    });
    const r = await approval.handle({
      action: "approve",
      lessonId: created.id,
      via: "telegram",
    });
    expect(r.updated).toBe(true);
    expect(r.finalStatus).toBe("ACTIVE");

    const [activated] = await tp.db.select().from(lessons).where(eq(lessons.id, created.id));
    expect(activated?.status).toBe("ACTIVE");

    const evtsAfter = await tp.db
      .select()
      .from(lessonEvents)
      .where(eq(lessonEvents.lessonId, created.id))
      .orderBy(lessonEvents.sequence);
    expect(evtsAfter.some((e) => e.type === "HumanApproved")).toBe(true);

    // Run runReviewer → assert prompt receives the active lesson title.
    // We seed a minimal tickSnapshot and capture the LLM input via a
    // dedicated reviewer FakeLLMProvider in deps.llmProviders.
    let capturedReviewerPrompt = "";
    const reviewerLLM = new FakeLLMProvider({
      name: "fake",
      completeImpl: async (input) => {
        capturedReviewerPrompt = input.userPrompt;
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
    deps.llmProviders.set("fake", reviewerLLM);

    const reviewSnap = await deps.tickSnapshotStore.create({
      watchId,
      tickAt: new Date(),
      asset: "BTCUSDT",
      timeframe: "1h",
      ohlcvUri: (
        await deps.artifactStore.put({
          kind: "ohlcv_snapshot",
          content: Buffer.from("[]"),
          mimeType: "application/json",
        })
      ).uri,
      chartUri: (
        await deps.artifactStore.put({
          kind: "chart_image",
          content: Buffer.from("png"),
          mimeType: "image/png",
        })
      ).uri,
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

    // Create a fresh setup for the reviewer (the previous one is closed).
    const reviewerSetupId = crypto.randomUUID();
    await deps.setupRepo.create({
      id: reviewerSetupId,
      watchId,
      asset: "BTCUSDT",
      timeframe: "1h",
      status: "REVIEWING",
      currentScore: 25,
      patternHint: "double_bottom",
      invalidationLevel: 90,
      direction: "LONG",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
      workflowId: `setup-${reviewerSetupId}`,
    });

    const setupActivities = buildSetupActivities(deps);
    await setupActivities.runReviewer({
      setupId: reviewerSetupId,
      tickSnapshotId: reviewSnap.id,
      watchId,
    });

    // The active lesson title should appear in the reviewer's prompt.
    expect(capturedReviewerPrompt).toContain(
      "Confirm structural confluence before strengthening on momentum alone",
    );
  }, 120_000);
});
