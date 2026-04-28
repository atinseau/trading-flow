import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import { buildProviderRegistry } from "@adapters/llm/buildProviderRegistry";
import { BinanceFetcher } from "@adapters/market-data/BinanceFetcher";
import { YahooFinanceFetcher } from "@adapters/market-data/YahooFinanceFetcher";
import { TelegramNotifier } from "@adapters/notify/TelegramNotifier";
import { FilesystemArtifactStore } from "@adapters/persistence/FilesystemArtifactStore";
import { PostgresEventStore } from "@adapters/persistence/PostgresEventStore";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
import { PostgresTickSnapshotStore } from "@adapters/persistence/PostgresTickSnapshotStore";
import { BinanceWsPriceFeed } from "@adapters/price-feed/BinanceWsPriceFeed";
import { YahooPollingPriceFeed } from "@adapters/price-feed/YahooPollingPriceFeed";
import { SystemClock } from "@adapters/time/SystemClock";
import { parseTimeframeToMs } from "@domain/ports/Clock";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { PriceFeed } from "@domain/ports/PriceFeed";
import type { Config } from "@domain/schemas/Config";
import { Client, Connection } from "@temporalio/client";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export type Container = {
  deps: ActivityDeps;
  pgPool: pg.Pool;
  chartRenderer: PlaywrightChartRenderer;
  shutdown: () => Promise<void>;
};

export async function buildContainer(config: Config): Promise<Container> {
  const pool = new pg.Pool({
    connectionString: config.database.url,
    max: config.database.pool_size,
    ssl: config.database.ssl,
  });
  const db = drizzle(pool);

  const marketDataFetchers = new Map<string, MarketDataFetcher>();
  if (config.market_data.binance) {
    marketDataFetchers.set(
      "binance",
      new BinanceFetcher(config.market_data.binance as { baseUrl?: string }),
    );
  }
  if (config.market_data.yahoo) {
    marketDataFetchers.set(
      "yahoo",
      new YahooFinanceFetcher(config.market_data.yahoo as { userAgent?: string }),
    );
  }

  const chartRenderer = new PlaywrightChartRenderer({ poolSize: 2 });
  await chartRenderer.warmUp();

  const indicatorCalculator = new PureJsIndicatorCalculator();
  const llmProviders = buildProviderRegistry(config);
  const notifier = new TelegramNotifier({ token: config.notifications.telegram.bot_token });

  const priceFeeds = new Map<string, PriceFeed>();
  priceFeeds.set("binance_ws", new BinanceWsPriceFeed());
  priceFeeds.set("yahoo_polling", new YahooPollingPriceFeed());

  const setupRepo = new PostgresSetupRepository(db, parseTimeframeToMs);
  const eventStore = new PostgresEventStore(db);
  const tickSnapshotStore = new PostgresTickSnapshotStore(db);
  const artifactStore = new FilesystemArtifactStore(
    db,
    config.artifacts.base_dir ?? "/data/artifacts",
  );
  const clock = new SystemClock();

  const watchById = (id: string) => config.watches.find((w) => w.id === id);

  // Temporal Client (for activities that need to signal external workflows,
  // e.g. priceMonitor signalling setupWorkflow on invalidation breach).
  const tempConnection = await Connection.connect({ address: config.temporal.address });
  const temporalClient = new Client({
    connection: tempConnection,
    namespace: config.temporal.namespace,
  });

  const deps: ActivityDeps = {
    marketDataFetchers,
    chartRenderer,
    indicatorCalculator,
    llmProviders,
    priceFeeds,
    notifier,
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock,
    config,
    watchById,
    temporalClient,
    db,
  };

  return {
    deps,
    pgPool: pool,
    chartRenderer,
    async shutdown() {
      await chartRenderer.dispose();
      await tempConnection.close();
      await pool.end();
    },
  };
}
