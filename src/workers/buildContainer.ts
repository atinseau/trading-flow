import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import { buildProviderRegistry } from "@adapters/llm/buildProviderRegistry";
import { BinanceFetcher } from "@adapters/market-data/BinanceFetcher";
import { YahooFinanceFetcher } from "@adapters/market-data/YahooFinanceFetcher";
import { TelegramNotifier } from "@adapters/notify/TelegramNotifier";
import { FilesystemArtifactStore } from "@adapters/persistence/FilesystemArtifactStore";
import { PostgresEventStore } from "@adapters/persistence/PostgresEventStore";
import { PostgresLLMUsageStore } from "@adapters/persistence/PostgresLLMUsageStore";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
import { PostgresTickSnapshotStore } from "@adapters/persistence/PostgresTickSnapshotStore";
import { BinanceWsPriceFeed } from "@adapters/price-feed/BinanceWsPriceFeed";
import { YahooPollingPriceFeed } from "@adapters/price-feed/YahooPollingPriceFeed";
import { SystemClock } from "@adapters/time/SystemClock";
import { parseTimeframeToMs } from "@domain/ports/Clock";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { PriceFeed } from "@domain/ports/PriceFeed";
import type { Config } from "@domain/schemas/Config";
import { Client, Connection } from "@temporalio/client";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export type WorkerRole = "scheduler" | "analysis" | "notification";

export type Container = {
  deps: ActivityDeps;
  pgPool: pg.Pool;
  chartRenderer: PlaywrightChartRenderer | null;
  shutdown: () => Promise<void>;
};

/**
 * Build a role-specific dependency container for a worker.
 *
 * Different workers need different subsets of adapters; building only what's
 * needed avoids spawning Chromium for the notification worker (~250 MB),
 * skipping unused Temporal connections, and so on.
 *
 * Role matrix:
 * - `scheduler`     → all adapters (chart renderer, indicators, market data, price feeds, LLM, Temporal client)
 * - `analysis`      → no chart renderer, no indicators, no market data, no price feeds; needs LLM + notifier
 * - `notification`  → no chart, no indicators, no market data, no price feeds, no LLM, no Temporal client; only notifier + persistence
 *
 * Note on the `ActivityDeps` typing: the type contract advertises every field
 * as non-null. For role-specific containers we use `null as unknown as T` casts
 * for fields the worker never accesses. At runtime, calling e.g.
 * `deps.chartRenderer.render(...)` from an analysis-worker activity would crash,
 * but workflow→activity routing guarantees that activity is only registered on
 * the scheduler worker. This is enforced by the activity-registration call in
 * each `*-worker.ts` entry point — be careful when wiring new activities.
 */
export async function buildContainer(config: Config, role: WorkerRole): Promise<Container> {
  const pool = new pg.Pool({
    connectionString: config.database.url,
    max: config.database.pool_size,
    ssl: config.database.ssl,
  });
  const db = drizzle(pool);

  // Market data fetchers — only the scheduler runs fetchOHLCV.
  const marketDataFetchers = new Map<string, MarketDataFetcher>();
  if (role === "scheduler") {
    if (config.market_data.binance) {
      marketDataFetchers.set(
        "binance",
        new BinanceFetcher(),
      );
    }
    if (config.market_data.yahoo) {
      marketDataFetchers.set(
        "yahoo",
        new YahooFinanceFetcher(config.market_data.yahoo as { userAgent?: string }),
      );
    }
  }

  // Chart renderer — only scheduler renders charts (Chromium ~250 MB).
  let chartRenderer: PlaywrightChartRenderer | null = null;
  if (role === "scheduler") {
    chartRenderer = new PlaywrightChartRenderer({ poolSize: 2 });
    await chartRenderer.warmUp();
  }

  // Indicator calculator — only scheduler runs indicator activities.
  const indicatorCalculator = role === "scheduler" ? new PureJsIndicatorCalculator() : null;

  // LLM providers — needed by scheduler (Detector) and analysis (Reviewer/Finalizer); not notification.
  const llmUsageStore = new PostgresLLMUsageStore(db);
  const llmProviders =
    role === "notification"
      ? new Map<string, LLMProvider>()
      : buildProviderRegistry(config, llmUsageStore);

  // Notifier — required by notification worker and by setup activities scheduled on the analysis worker.
  const notifier =
    role === "notification" || role === "analysis"
      ? new TelegramNotifier({ token: config.notifications.telegram.bot_token })
      : null;

  // Price feeds — only scheduler runs the priceMonitor activity.
  const priceFeeds = new Map<string, PriceFeed>();
  if (role === "scheduler") {
    priceFeeds.set("binance_ws", new BinanceWsPriceFeed());
    priceFeeds.set("yahoo_polling", new YahooPollingPriceFeed());
  }

  // Persistence — every worker needs durable storage.
  const setupRepo = new PostgresSetupRepository(db, parseTimeframeToMs);
  const eventStore = new PostgresEventStore(db);
  const tickSnapshotStore = new PostgresTickSnapshotStore(db);
  const artifactStore = new FilesystemArtifactStore(
    db,
    config.artifacts.base_dir ?? "/data/artifacts",
  );
  const clock = new SystemClock();

  const watchById = (id: string) => config.watches.find((w) => w.id === id);

  // Temporal client — scheduler signals setup workflows from priceMonitor activity.
  // Analysis and notification workers don't need to signal external workflows.
  let temporalConnection: Connection | null = null;
  let temporalClient: Client | null = null;
  if (role === "scheduler") {
    temporalConnection = await Connection.connect({ address: config.temporal.address });
    temporalClient = new Client({
      connection: temporalConnection,
      namespace: config.temporal.namespace,
    });
  }

  // ActivityDeps requires every field non-null. For role-specific containers we
  // satisfy the type contract via `null as unknown as T` for fields the worker's
  // registered activities never touch (see JSDoc above).
  const deps: ActivityDeps = {
    marketDataFetchers,
    chartRenderer: chartRenderer ?? (null as unknown as PlaywrightChartRenderer),
    indicatorCalculator: indicatorCalculator ?? (null as unknown as PureJsIndicatorCalculator),
    llmProviders,
    priceFeeds,
    notifier: notifier ?? (null as unknown as TelegramNotifier),
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock,
    config,
    watchById,
    temporalClient: temporalClient ?? (null as unknown as Client),
    db,
  };

  return {
    deps,
    pgPool: pool,
    chartRenderer,
    async shutdown() {
      if (chartRenderer) await chartRenderer.dispose();
      if (temporalConnection) await temporalConnection.close();
      await pool.end();
    },
  };
}
