import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemArtifactStore } from "@adapters/persistence/FilesystemArtifactStore";
import { PostgresEventStore } from "@adapters/persistence/PostgresEventStore";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
import { PostgresTickSnapshotStore } from "@adapters/persistence/PostgresTickSnapshotStore";
import { events, setups } from "@adapters/persistence/schema";
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
import { InMemoryLessonStore } from "@test-fakes/InMemoryLessonStore";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { buildSetupActivities } from "@workflows/setup/activities";
import { type InitialEvidence, setupWorkflow } from "@workflows/setup/setupWorkflow";
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

const watchId = "btc-1h";
// "fake" provider values key into test-only llmProviders maps.
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

const testConfig: { watches: WatchConfig[] } = { watches: [testWatch] };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./migrations" });
  baseDir = await mkdtemp(join(tmpdir(), "tf-int-"));
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
  await pool?.end();
  await container?.stop();
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

describe("SetupWorkflow integration (real Postgres + real activities)", () => {
  test("CONFIRMED happy path: SetupCreated -> Strengthened -> Confirmed -> TRACKING + Telegram fired", async () => {
    const tickSnapshotStore = new PostgresTickSnapshotStore(db);
    const setupRepo = new PostgresSetupRepository(db, parseTimeframeToMs);
    const eventStore = new PostgresEventStore(db);
    const artifactStore = new FilesystemArtifactStore(db, baseDir);

    // Seed an OHLCV artifact (any bytes)
    const ohlcvArtifact = await artifactStore.put({
      kind: "ohlcv_snapshot",
      content: Buffer.from(
        JSON.stringify([{ open: 100, high: 110, low: 90, close: 105, volume: 100 }]),
      ),
      mimeType: "application/json",
    });
    const chartArtifact = await artifactStore.put({
      kind: "chart_image",
      content: Buffer.from("fake-png-bytes"),
      mimeType: "image/png",
    });

    const tickSnap = await tickSnapshotStore.create({
      watchId,
      tickAt: new Date(),
      asset: "BTCUSDT",
      timeframe: "1h",
      ohlcvUri: ohlcvArtifact.uri,
      chartUri: chartArtifact.uri,
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

    // Single fake LLM that dispatches based on systemPrompt to discriminate
    // reviewer vs finalizer roles (both use provider "fake" per watch config).
    // Keys "Reviewer" / "Finalizer" come from the v3 English prompts in
    // prompts/reviewer.system.md and prompts/finalizer.system.md.
    const dispatchingLLM: LLMProvider = new FakeLLMProvider({
      name: "fake",
      available: true,
      completeImpl: async (input) => {
        if (input.systemPrompt.includes("Reviewer")) {
          return {
            content: "{}",
            parsed: {
              type: "STRENGTHEN",
              scoreDelta: 60,
              observations: [{ kind: "test", text: "very bullish" }],
              reasoning: "synthetic test",
            },
            costUsd: 0.001,
            latencyMs: 1,
            promptTokens: 100,
            completionTokens: 50,
          };
        }
        if (input.systemPrompt.includes("Finalizer")) {
          return {
            content: "{}",
            parsed: {
              go: true,
              reasoning: "GO test",
              entry: 105,
              stop_loss: 90,
              take_profit: [120, 130],
            },
            costUsd: 0.005,
            latencyMs: 100,
            promptTokens: 200,
            completionTokens: 100,
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

    const llmProviders = new Map<string, LLMProvider>();
    llmProviders.set("fake", dispatchingLLM);

    const fakeNotifier = new FakeNotifier();

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

    const deps: ActivityDeps = {
      marketDataFetchers: new Map([["binance", new FakeMarketDataFetcher()]]),
      chartRenderer: new FakeChartRenderer(),
      indicatorCalculator: new FakeIndicatorCalculator(),
      llmProviders,
      priceFeeds: new Map([["fake", new FakePriceFeed()]]),
      notifier: fakeNotifier,
      setupRepo,
      watchRepo: {
        findAll: async () => [],
        findById: async () => null,
        findEnabled: async () => [],
        findAllWithValidation: async () => [],
      },
      eventStore,
      artifactStore,
      tickSnapshotStore,
      clock: new SystemClock(),
      config: testConfig,
      infra,
      watchById: async (id) => (id === watchId ? testWatch : null),
      temporalClient: env.client,
      scheduleController: { pause: async () => {}, unpause: async () => {} },
      db,
      pgPool: pool,
      lessonStore: new InMemoryLessonStore(),
      lessonEventStore: null as unknown as ActivityDeps["lessonEventStore"],
      feedbackContextRegistry: null as unknown as ActivityDeps["feedbackContextRegistry"],
      notifyLessonPending: async () => {},
    };

    const activities = buildSetupActivities(deps);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test-integration",
      workflowsPath: require.resolve("../../src/workflows/setup/setupWorkflow.ts"),
      activities,
    });

    const initial: InitialEvidence = {
      setupId: crypto.randomUUID(),
      watchId,
      asset: "BTCUSDT",
      timeframe: "1h",
      patternHint: "double_bottom",
      direction: "LONG",
      invalidationLevel: 95,
      initialScore: 25,
      ttlCandles: 50,
      // Use a 1-year TTL: TestWorkflowEnvironment.createTimeSkipping() fast-forwards
      // simulated time when the workflow awaits, so a short TTL (e.g. 50h) can fire
      // before signals are processed. A 1y TTL guarantees the timer never trips
      // within the test scope.
      ttlExpiresAt: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
      scoreThresholdFinalizer: 80,
      scoreThresholdDead: 10,
      scoreMax: 100,
      detectorPromptVersion: "detector_v3",
      // Disabled here — this integration test focuses on the setup workflow
      // path, not the feedback loop (covered by setupWorkflow.feedback.test).
      feedbackEnabled: false,
    };

    let finalStatus: string | undefined;

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [initial],
        workflowId: `setup-${initial.setupId}`,
        taskQueue: "test-integration",
      });

      // Send a review signal pointing at the seeded tickSnapshot.
      // This will trigger STRENGTHEN +60 -> score 85 -> FINALIZING -> finalizer GO
      // -> TRACKING -> trackingLoop awaits trackingPrice signals.
      await handle.signal("review", { tickSnapshotId: tickSnap.id });

      // Wait for the workflow to enter TRACKING phase before driving prices.
      // Poll the state via the durable workflow query.
      const { getStateQuery } = await import("@workflows/setup/setupWorkflow");
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const state = await handle.query(getStateQuery);
        if (state.status === "TRACKING") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // Drive both TPs: finalizer returned take_profit: [120, 130].
      // First signal hits TP1 (also moves SL to breakeven), second hits TP2 (final).
      await handle.signal("trackingPrice", {
        currentPrice: 120,
        observedAt: new Date().toISOString(),
      });
      await handle.signal("trackingPrice", {
        currentPrice: 130,
        observedAt: new Date().toISOString(),
      });

      finalStatus = await handle.result();
    });

    expect(finalStatus).toBe("CLOSED");

    // ASSERTION 1: setup row exists in Postgres
    const [setupRow] = await db.select().from(setups).where(eq(setups.id, initial.setupId));
    expect(setupRow).toBeDefined();
    expect(setupRow?.asset).toBe("BTCUSDT");
    expect(setupRow?.status).toBe("CLOSED");
    expect(Number(setupRow?.currentScore)).toBeGreaterThanOrEqual(85);

    // ASSERTION 2: events persisted with multiple types
    const evts = await db
      .select()
      .from(events)
      .where(eq(events.setupId, initial.setupId))
      .orderBy(events.sequence);
    const types = evts.map((e) => e.type);
    expect(types).toContain("SetupCreated");
    expect(types).toContain("Strengthened");
    expect(types).toContain("Confirmed");
    expect(types).toContain("TPHit");
    expect(types).toContain("TrailingMoved");

    // ASSERTION 3: telegram notification fired on Confirmed
    expect(fakeNotifier.sentMessages.length).toBeGreaterThanOrEqual(1);
    const confirmedMsg = fakeNotifier.sentMessages.find((m) => m.text.includes("LONG"));
    expect(confirmedMsg).toBeDefined();
    expect(confirmedMsg?.chatId).toBe("test-chat");
    expect(confirmedMsg?.text).toContain("BTCUSDT");
    expect(confirmedMsg?.text).toContain("105"); // entry price
  }, 120_000);
});
