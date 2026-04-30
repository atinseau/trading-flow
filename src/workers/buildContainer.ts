import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import { buildProviderRegistry } from "@adapters/llm/buildProviderRegistry";
import { BinanceFetcher } from "@adapters/market-data/BinanceFetcher";
import { YahooFinanceFetcher } from "@adapters/market-data/YahooFinanceFetcher";
import { ConsoleNotifier } from "@adapters/notify/ConsoleNotifier";
import { MultiNotifier } from "@adapters/notify/MultiNotifier";
import { TelegramNotifier } from "@adapters/notify/TelegramNotifier";
import { FilesystemArtifactStore } from "@adapters/persistence/FilesystemArtifactStore";
import { PostgresEventStore } from "@adapters/persistence/PostgresEventStore";
import { PostgresLLMUsageStore } from "@adapters/persistence/PostgresLLMUsageStore";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
import { PostgresTickSnapshotStore } from "@adapters/persistence/PostgresTickSnapshotStore";
import { PostgresWatchRepository } from "@adapters/persistence/PostgresWatchRepository";
import { BinanceWsPriceFeed } from "@adapters/price-feed/BinanceWsPriceFeed";
import { YahooPollingPriceFeed } from "@adapters/price-feed/YahooPollingPriceFeed";
import { TemporalScheduleController } from "@adapters/temporal/TemporalScheduleController";
import { SystemClock } from "@adapters/time/SystemClock";
import type { InfraConfig } from "@config/InfraConfig";
import { parseTimeframeToMs } from "@domain/ports/Clock";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Notifier } from "@domain/ports/Notifier";
import type { PriceFeed } from "@domain/ports/PriceFeed";
import type { ScheduleController } from "@domain/ports/ScheduleController";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
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
 * Role matrix:
 * - `scheduler`     → all adapters (chart renderer, indicators, market data, price feeds, LLM, Temporal client)
 * - `analysis`      → no chart renderer, no indicators, no market data, no price feeds; needs LLM + notifier
 * - `notification`  → no chart, no indicators, no market data, no price feeds, no LLM, no Temporal client; only notifier + persistence
 */
export async function buildContainer(
  infra: InfraConfig,
  watches: WatchConfig[],
  role: WorkerRole,
): Promise<Container> {
  const pool = new pg.Pool({
    connectionString: infra.database.url,
    max: infra.database.pool_size,
    ssl: infra.database.ssl,
  });
  const db = drizzle(pool);

  const setupRepo = new PostgresSetupRepository(db, parseTimeframeToMs);
  const eventStore = new PostgresEventStore(db);
  const tickSnapshotStore = new PostgresTickSnapshotStore(db);
  const artifactStore = new FilesystemArtifactStore(db, infra.artifacts.base_dir);
  const llmUsageStore = new PostgresLLMUsageStore(db);
  const clock = new SystemClock();

  const watchRepo = new PostgresWatchRepository(db);

  const usedSources = new Set(watches.filter((w) => w.enabled).map((w) => w.asset.source));

  const marketDataFetchers = new Map<string, MarketDataFetcher>();
  if (role === "scheduler") {
    if (usedSources.has("binance")) marketDataFetchers.set("binance", new BinanceFetcher());
    if (usedSources.has("yahoo")) marketDataFetchers.set("yahoo", new YahooFinanceFetcher());
  }

  let chartRenderer: PlaywrightChartRenderer | null = null;
  if (role === "scheduler") {
    chartRenderer = new PlaywrightChartRenderer({ poolSize: 2 });
    await chartRenderer.warmUp();
  }

  const indicatorCalculator = role === "scheduler" ? new PureJsIndicatorCalculator() : null;

  const llmProviders =
    role === "notification"
      ? new Map<string, LLMProvider>()
      : buildProviderRegistry(infra, llmUsageStore);

  const consoleNotifier = new ConsoleNotifier();
  const notifier: Notifier =
    role === "notification" || role === "analysis"
      ? new MultiNotifier([
          consoleNotifier,
          new TelegramNotifier({ token: infra.notifications.telegram.bot_token }),
        ])
      : (null as unknown as Notifier);

  const priceFeeds = new Map<string, PriceFeed>();
  if (role === "scheduler") {
    priceFeeds.set("binance_ws", new BinanceWsPriceFeed());
    priceFeeds.set("yahoo_polling", new YahooPollingPriceFeed());
  }

  let temporalConnection: Connection | null = null;
  let temporalClient: Client | null = null;
  if (role === "scheduler") {
    temporalConnection = await Connection.connect({ address: infra.temporal.address });
    temporalClient = new Client({
      connection: temporalConnection,
      namespace: infra.temporal.namespace,
    });
  }

  const scheduleController: ScheduleController =
    temporalClient !== null
      ? new TemporalScheduleController(temporalClient)
      : (null as unknown as ScheduleController);

  const deps: ActivityDeps = {
    marketDataFetchers,
    chartRenderer: chartRenderer ?? (null as unknown as PlaywrightChartRenderer),
    indicatorCalculator: indicatorCalculator ?? (null as unknown as PureJsIndicatorCalculator),
    llmProviders,
    priceFeeds,
    notifier,
    setupRepo,
    watchRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock,
    config: { watches: [...watches] },
    infra,
    watchById: (id: string) => watchRepo.findById(id),
    temporalClient: temporalClient ?? (null as unknown as Client),
    scheduleController,
    db,
    pgPool: pool,
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
