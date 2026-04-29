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
import type { WatchesConfig } from "@domain/schemas/WatchesConfig";
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
 * `infra` is always required (env-driven creds + addresses).
 * `watches` is null in standby mode (no `config/watches.yaml`); the container is
 * minimally wired (Postgres pool only) and no Temporal Worker should be registered.
 *
 * Role matrix when `watches !== null`:
 * - `scheduler`     → all adapters (chart renderer, indicators, market data, price feeds, LLM, Temporal client)
 * - `analysis`      → no chart renderer, no indicators, no market data, no price feeds; needs LLM + notifier
 * - `notification`  → no chart, no indicators, no market data, no price feeds, no LLM, no Temporal client; only notifier + persistence
 *
 * The `null as unknown as T` cast pattern is preserved for fields the worker's
 * registered activities never access at runtime (see Task 11 in the plan).
 */
export async function buildContainer(
  infra: InfraConfig,
  watches: WatchesConfig | null,
  role: WorkerRole,
): Promise<Container> {
  const pool = new pg.Pool({
    connectionString: infra.database.url,
    max: infra.database.pool_size,
    ssl: infra.database.ssl,
  });
  const db = drizzle(pool);

  // Persistence — needed in standby and active.
  const setupRepo = new PostgresSetupRepository(db, parseTimeframeToMs);
  const eventStore = new PostgresEventStore(db);
  const tickSnapshotStore = new PostgresTickSnapshotStore(db);
  const artifactStore = new FilesystemArtifactStore(db, infra.artifacts.base_dir);
  const llmUsageStore = new PostgresLLMUsageStore(db);
  const clock = new SystemClock();

  // Persistence — always available in both standby and active.
  const watchRepo = new PostgresWatchRepository(db);

  // Standby — no watches, no domain wiring.
  if (watches === null) {
    const deps: ActivityDeps = {
      marketDataFetchers: new Map<string, MarketDataFetcher>(),
      chartRenderer: null as unknown as PlaywrightChartRenderer,
      indicatorCalculator: null as unknown as PureJsIndicatorCalculator,
      llmProviders: new Map<string, LLMProvider>(),
      priceFeeds: new Map<string, PriceFeed>(),
      notifier: null as unknown as Notifier,
      setupRepo,
      watchRepo,
      eventStore,
      artifactStore,
      tickSnapshotStore,
      clock,
      config: null as unknown as WatchesConfig,
      infra,
      watchById: (id: string) => watchRepo.findById(id),
      temporalClient: null as unknown as Client,
      scheduleController: null as unknown as ScheduleController,
      db,
    };
    return {
      deps,
      pgPool: pool,
      chartRenderer: null,
      async shutdown() {
        await pool.end();
      },
    };
  }

  // Active mode — full wiring.
  const marketDataFetchers = new Map<string, MarketDataFetcher>();
  if (role === "scheduler") {
    if (watches.market_data.includes("binance")) {
      marketDataFetchers.set("binance", new BinanceFetcher());
    }
    if (watches.market_data.includes("yahoo")) {
      marketDataFetchers.set("yahoo", new YahooFinanceFetcher());
    }
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
      : buildProviderRegistry(watches, infra, llmUsageStore);

  // Notifier — console always; telegram appended via MultiNotifier when opted in.
  // chatId is supplied per-call by activities from `deps.infra.notifications.telegram.chat_id`.
  const consoleNotifier = new ConsoleNotifier();
  let notifier: Notifier;
  if (watches.notifications.telegram) {
    notifier = new MultiNotifier([
      consoleNotifier,
      new TelegramNotifier({ token: infra.notifications.telegram.bot_token }),
    ]);
  } else {
    notifier = consoleNotifier;
  }
  // Notifier is only registered on workers that actually emit notifications.
  const effectiveNotifier =
    role === "notification" || role === "analysis" ? notifier : (null as unknown as Notifier);

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
    notifier: effectiveNotifier,
    setupRepo,
    watchRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock,
    config: watches,
    infra,
    watchById: (id: string) => watchRepo.findById(id),
    temporalClient: temporalClient ?? (null as unknown as Client),
    scheduleController,
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
