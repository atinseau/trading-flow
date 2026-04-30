/**
 * Composition root for the `replay-feedback` CLI.
 *
 * Mirrors the analysis-worker bootstrap (see `src/workers/buildContainer.ts`)
 * but assembled directly here because the CLI uses the activities
 * synchronously without a Temporal worker. If duplication grows further,
 * extract a shared `bootstrapFeedbackDeps` helper used by both paths.
 *
 * Notable departures from the worker:
 *   - notifyLessonPending is logger-only — replay must not produce duplicate
 *     Telegram notifications.
 *   - feedbackContextRegistry is wired with the 4 canonical providers (Phase 13
 *     will do the same in the worker).
 *   - No Temporal client (CLI invokes activities directly, never starts a
 *     workflow).
 */
import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { ChartPostMortemContextProvider } from "@adapters/feedback-context/ChartPostMortemContextProvider";
import { FeedbackContextProviderRegistry } from "@adapters/feedback-context/FeedbackContextProviderRegistry";
import { PostMortemOhlcvContextProvider } from "@adapters/feedback-context/PostMortemOhlcvContextProvider";
import { SetupEventsContextProvider } from "@adapters/feedback-context/SetupEventsContextProvider";
import { TickSnapshotsContextProvider } from "@adapters/feedback-context/TickSnapshotsContextProvider";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import { buildProviderRegistry } from "@adapters/llm/buildProviderRegistry";
import { BinanceFetcher } from "@adapters/market-data/BinanceFetcher";
import { YahooFinanceFetcher } from "@adapters/market-data/YahooFinanceFetcher";
import { ConsoleNotifier } from "@adapters/notify/ConsoleNotifier";
import { FilesystemArtifactStore } from "@adapters/persistence/FilesystemArtifactStore";
import { PostgresEventStore } from "@adapters/persistence/PostgresEventStore";
import { PostgresLessonEventStore } from "@adapters/persistence/PostgresLessonEventStore";
import { PostgresLessonStore } from "@adapters/persistence/PostgresLessonStore";
import { PostgresLLMUsageStore } from "@adapters/persistence/PostgresLLMUsageStore";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
import { PostgresTickSnapshotStore } from "@adapters/persistence/PostgresTickSnapshotStore";
import { SystemClock } from "@adapters/time/SystemClock";
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { parseTimeframeToMs } from "@domain/ports/Clock";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Notifier } from "@domain/ports/Notifier";
import type { PriceFeed } from "@domain/ports/PriceFeed";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const log = getLogger({ component: "replay-feedback-cli" });

export type FeedbackCliWiring = {
  deps: ActivityDeps;
  watches: WatchConfig[];
  pool: pg.Pool;
  shutdown: () => Promise<void>;
};

export async function wireFeedbackActivitiesForCli(): Promise<FeedbackCliWiring> {
  const infra = loadInfraConfig();
  const pool = new pg.Pool({
    connectionString: infra.database.url,
    max: infra.database.pool_size,
    ssl: infra.database.ssl,
  });
  const watches = await loadWatchesFromDb(pool);
  if (watches.length === 0) {
    await pool.end();
    throw new Error(
      "replay-feedback requires at least one watch config in Postgres (watch_configs)",
    );
  }

  const db = drizzle(pool);

  // Stores
  const setupRepo = new PostgresSetupRepository(db, parseTimeframeToMs);
  const eventStore = new PostgresEventStore(db);
  const tickSnapshotStore = new PostgresTickSnapshotStore(db);
  const artifactStore = new FilesystemArtifactStore(db, infra.artifacts.base_dir);
  const llmUsageStore = new PostgresLLMUsageStore(db);
  const lessonStore = new PostgresLessonStore(db);
  const lessonEventStore = new PostgresLessonEventStore(db);
  const clock = new SystemClock();

  // Market data fetchers — same selection as scheduler role.
  const usedSources = new Set(watches.filter((w) => w.enabled).map((w) => w.asset.source));
  const marketDataFetchers = new Map<string, MarketDataFetcher>();
  if (usedSources.has("binance")) marketDataFetchers.set("binance", new BinanceFetcher());
  if (usedSources.has("yahoo")) marketDataFetchers.set("yahoo", new YahooFinanceFetcher());

  // Chart renderer (poolSize=1: CLI runs once, then exits).
  const indicatorRegistry = new IndicatorRegistry();
  const chartRenderer = new PlaywrightChartRenderer(indicatorRegistry, { poolSize: 1 });
  await chartRenderer.warmUp();

  const indicatorCalculator = new PureJsIndicatorCalculator();
  const llmProviders = buildProviderRegistry(infra, llmUsageStore);

  // Replay must not produce duplicate Telegram notifications.
  const notifier: Notifier = new ConsoleNotifier();

  const watchById = async (id: string) => watches.find((w) => w.id === id) ?? null;

  // FeedbackContextProviderRegistry — the 4 canonical providers. The chart and
  // post-mortem providers each take a single MarketDataFetcher; we resolve it
  // lazily per-call from the watch's asset source. Today the registry stores
  // them up front, so we create one provider instance per known source and the
  // composer dispatches by `isApplicable` — but the providers don't actually
  // gate on source. For replay, we wire the FIRST available fetcher: the
  // workflow only ever runs against one watch at a time and the CLI errors
  // out earlier if no fetchers are configured.
  const firstFetcher = marketDataFetchers.values().next().value;
  if (!firstFetcher) {
    await chartRenderer.dispose();
    await pool.end();
    throw new Error(
      "replay-feedback: no market_data fetcher configured in watches.yaml — cannot run feedback context providers",
    );
  }

  const feedbackContextRegistry = new FeedbackContextProviderRegistry({
    "setup-events": new SetupEventsContextProvider({ eventStore }),
    "tick-snapshots": new TickSnapshotsContextProvider({ tickStore: tickSnapshotStore }),
    "post-mortem-ohlcv": new PostMortemOhlcvContextProvider({
      marketDataFetcher: firstFetcher,
    }),
    "chart-post-mortem": new ChartPostMortemContextProvider({
      chartRenderer,
      marketDataFetcher: firstFetcher,
      artifactStore,
    }),
  });

  const notifyLessonPending: ActivityDeps["notifyLessonPending"] = async (input) => {
    log.info(
      { lessonId: input.lessonId, kind: input.kind, watchId: input.watchId },
      "notifyLessonPending (replay-feedback CLI: log-only, no Telegram)",
    );
  };

  const deps: ActivityDeps = {
    marketDataFetchers,
    chartRenderer,
    indicatorCalculator,
    llmProviders,
    priceFeeds: new Map<string, PriceFeed>(),
    notifier,
    setupRepo,
    watchRepo: null as unknown as ActivityDeps["watchRepo"],
    scheduleController: null as unknown as ActivityDeps["scheduleController"],
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock,
    config: { watches },
    infra,
    watchById,
    temporalClient: null as unknown as Client,
    db,
    pgPool: pool,
    lessonStore,
    lessonEventStore,
    feedbackContextRegistry,
    notifyLessonPending,
  };

  return {
    deps,
    watches,
    pool,
    async shutdown() {
      await chartRenderer.dispose();
      await pool.end();
    },
  };
}
