import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemArtifactStore } from "@adapters/persistence/FilesystemArtifactStore";
import { PostgresEventStore } from "@adapters/persistence/PostgresEventStore";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
import { PostgresTickSnapshotStore } from "@adapters/persistence/PostgresTickSnapshotStore";
import { tickSnapshots } from "@adapters/persistence/schema";
import { SystemClock } from "@adapters/time/SystemClock";
import { parseTimeframeToMs } from "@domain/ports/Clock";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { FakeChartRenderer } from "@test-fakes/FakeChartRenderer";
import { FakeIndicatorCalculator } from "@test-fakes/FakeIndicatorCalculator";
import { FakeLLMProvider } from "@test-fakes/FakeLLMProvider";
import { FakeMarketDataFetcher } from "@test-fakes/FakeMarketDataFetcher";
import { FakeNotifier } from "@test-fakes/FakeNotifier";
import { FakePriceFeed } from "@test-fakes/FakePriceFeed";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { buildSchedulerActivities } from "@workflows/scheduler/activities";
import { schedulerWorkflow } from "@workflows/scheduler/schedulerWorkflow";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { Wait } from "testcontainers";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let env: TestWorkflowEnvironment;
let baseDir: string;

function makeWatch(id: string): WatchConfig {
  return {
    id,
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
    },
    optimization: { reviewer_skip_when_detector_corroborated: true },
    notify_on: ["confirmed", "rejected", "tp_hit", "sl_hit", "invalidated_after_confirmed"],
    include_chart_image: false,
    include_reasoning: true,
    budget: { pause_on_budget_exceeded: false },
  };
}

function makeConfig(watch: WatchConfig): { watches: WatchConfig[] } {
  return { watches: [watch] };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./migrations" });
  baseDir = await mkdtemp(join(tmpdir(), "tf-sched-"));
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
  await pool?.end();
  await container?.stop();
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

async function buildDeps(
  watchId: string,
  watch: WatchConfig,
  marketData: FakeMarketDataFetcher,
  indicators: FakeIndicatorCalculator,
  detectorLLM: LLMProvider,
): Promise<ActivityDeps> {
  const tickSnapshotStore = new PostgresTickSnapshotStore(db);
  const setupRepo = new PostgresSetupRepository(db, parseTimeframeToMs);
  const eventStore = new PostgresEventStore(db);
  const artifactStore = new FilesystemArtifactStore(db, baseDir);

  const llmProviders = new Map<string, LLMProvider>();
  llmProviders.set("fake", detectorLLM);

  return {
    marketDataFetchers: new Map([["fake", marketData]]),
    chartRenderer: new FakeChartRenderer(),
    indicatorCalculator: indicators,
    llmProviders,
    priceFeeds: new Map([["fake", new FakePriceFeed()]]),
    notifier: new FakeNotifier(),
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock: new SystemClock(),
    config: makeConfig(watch),
    infra: {
      database: { url: "x", pool_size: 1, ssl: false },
      temporal: { address: "x", namespace: "default", task_queues: { scheduler: "s", analysis: "a", notifications: "n" } },
      notifications: { telegram: { bot_token: "test-token", chat_id: "test-chat" } },
      llm: { openrouter_api_key: null },
      artifacts: { base_dir: "/tmp" },
      claude: { workspace_dir: "/tmp" },
    },
    watchById: (id) => (id === watchId ? watch : undefined),
    temporalClient: env.client,
    db,
    pgPool: pool,
  };
}

async function waitForSnapshot(
  watchId: string,
  attempts = 100,
  delayMs = 100,
): Promise<typeof tickSnapshots.$inferSelect | undefined> {
  for (let i = 0; i < attempts; i++) {
    const rows = await db.select().from(tickSnapshots).where(eq(tickSnapshots.watchId, watchId));
    if (rows.length > 0) return rows[0];
    await Bun.sleep(delayMs);
  }
  return undefined;
}

describe("SchedulerWorkflow integration (real Postgres + real activities)", () => {
  test("doTick → tick_snapshot persisted + Detector spawns child setup workflow", async () => {
    const watchId = "btc-1h-create";
    const watch = makeWatch(watchId);

    const marketData = new FakeMarketDataFetcher();
    marketData.candles = FakeMarketDataFetcher.generateLinear(250, 100);
    // Inject a volume spike on the last candle so the pre-filter passes via volume_spike rule.
    const last = marketData.candles[249];
    if (last) last.volume = 1000;

    const indicators = new FakeIndicatorCalculator();
    // RSI extreme + volume spike should both pass the pre-filter.
    indicators.set({ rsi: 20, lastVolume: 1000, volumeMa20: 100 });

    const detectorLLM = new FakeLLMProvider({
      name: "fake",
      available: true,
      completeImpl: async () => ({
        content: "{}",
        parsed: {
          corroborations: [],
          new_setups: [
            {
              type: "double_bottom",
              direction: "LONG",
              key_levels: { entry: 100, invalidation: 95, target: 110 },
              initial_score: 25,
              raw_observation: "test setup",
            },
          ],
          ignore_reason: null,
        },
        costUsd: 0.001,
        latencyMs: 1,
        promptTokens: 100,
        completionTokens: 50,
      }),
    });

    const deps = await buildDeps(watchId, watch, marketData, indicators, detectorLLM);
    const activities = buildSchedulerActivities(deps);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test-sched-create",
      workflowsPath: require.resolve("../../src/workflows/scheduler/schedulerWorkflow.ts"),
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(schedulerWorkflow, {
        args: [{ watchId, analysisTaskQueue: "test-sched-create-analysis" }],
        workflowId: `scheduler-${watchId}-test`,
        taskQueue: "test-sched-create",
      });

      await handle.signal("doTick");

      // Wait for the tick to complete (tickSnapshot row appears).
      const snap = await waitForSnapshot(watchId);
      expect(snap).toBeDefined();

      // Allow the workflow to finish runOneTick (start child + signal alive).
      // We don't assert on the child workflow itself — it's queued on
      // analysisTaskQueue with no worker, so it never executes — but its
      // submission via startChild is part of the scheduler's job.
      await Bun.sleep(200);

      await handle.terminate("test done");
    });

    // Assertions on Postgres state
    const snaps = await db.select().from(tickSnapshots).where(eq(tickSnapshots.watchId, watchId));
    expect(snaps.length).toBe(1);
    const snap = snaps[0];
    expect(snap?.preFilterPass).toBe(true);
    expect(snap?.asset).toBe("BTCUSDT");
    expect(snap?.timeframe).toBe("1h");

    // Detector LLM was called exactly once.
    expect((detectorLLM as FakeLLMProvider).callCount).toBe(1);
  }, 120_000);

  test("doTick with calm market → preFilter blocks, no Detector call, no setup", async () => {
    const watchId = "btc-1h-calm";
    const watch = makeWatch(watchId);

    const marketData = new FakeMarketDataFetcher();
    marketData.candles = FakeMarketDataFetcher.generateLinear(250, 100);
    // No volume spike — leave the last candle as the linear generator made it.

    // Calm-market indicators: RSI=50, atr=1=atrMa20, volume normal, recent extremes far from price.
    const indicators = new FakeIndicatorCalculator();
    indicators.set({
      rsi: 50,
      atr: 1,
      atrMa20: 1,
      lastVolume: 100,
      volumeMa20: 100,
      recentHigh: 200,
      recentLow: 0,
    });

    const detectorLLM = new FakeLLMProvider({
      name: "fake",
      available: true,
      completeImpl: async () => ({
        content: "{}",
        parsed: { corroborations: [], new_setups: [], ignore_reason: null },
        costUsd: 0,
        latencyMs: 1,
        promptTokens: 0,
        completionTokens: 0,
      }),
    });

    const deps = await buildDeps(watchId, watch, marketData, indicators, detectorLLM);
    const activities = buildSchedulerActivities(deps);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test-sched-calm",
      workflowsPath: require.resolve("../../src/workflows/scheduler/schedulerWorkflow.ts"),
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(schedulerWorkflow, {
        args: [{ watchId, analysisTaskQueue: "test-sched-calm-analysis" }],
        workflowId: `scheduler-${watchId}-test`,
        taskQueue: "test-sched-calm",
      });

      await handle.signal("doTick");

      // Calm path doesn't create a tick_snapshot — runOneTick returns early
      // when preFilter.passed is false. So poll for completion via a brief
      // wait, then verify no snapshot exists.
      await Bun.sleep(1500);

      await handle.terminate("test done");
    });

    // No snapshot should exist (calm path returns before createTickSnapshot).
    const snaps = await db.select().from(tickSnapshots).where(eq(tickSnapshots.watchId, watchId));
    expect(snaps.length).toBe(0);

    // Detector LLM was NOT called.
    expect((detectorLLM as FakeLLMProvider).callCount).toBe(0);
  }, 120_000);
});
