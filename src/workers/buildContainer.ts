import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { ChartPostMortemContextProvider } from "@adapters/feedback-context/ChartPostMortemContextProvider";
import { FeedbackContextProviderRegistry } from "@adapters/feedback-context/FeedbackContextProviderRegistry";
import { PostMortemOhlcvContextProvider } from "@adapters/feedback-context/PostMortemOhlcvContextProvider";
import { SetupEventsContextProvider } from "@adapters/feedback-context/SetupEventsContextProvider";
import { TickSnapshotsContextProvider } from "@adapters/feedback-context/TickSnapshotsContextProvider";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import { buildProviderRegistry } from "@adapters/llm/buildProviderRegistry";
import { BinanceFetcher } from "@adapters/market-data/BinanceFetcher";
import { YahooFinanceFetcher } from "@adapters/market-data/YahooFinanceFetcher";
import { ConsoleNotifier } from "@adapters/notify/ConsoleNotifier";
import { MultiNotifier } from "@adapters/notify/MultiNotifier";
import { TelegramNotifier } from "@adapters/notify/TelegramNotifier";
import { FilesystemArtifactStore } from "@adapters/persistence/FilesystemArtifactStore";
import { PostgresEventStore } from "@adapters/persistence/PostgresEventStore";
import { PostgresLessonEventStore } from "@adapters/persistence/PostgresLessonEventStore";
import { PostgresLessonStore } from "@adapters/persistence/PostgresLessonStore";
import { PostgresLLMUsageStore } from "@adapters/persistence/PostgresLLMUsageStore";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
import { PostgresTickSnapshotStore } from "@adapters/persistence/PostgresTickSnapshotStore";
import { BinanceWsPriceFeed } from "@adapters/price-feed/BinanceWsPriceFeed";
import { YahooPollingPriceFeed } from "@adapters/price-feed/YahooPollingPriceFeed";
import { SystemClock } from "@adapters/time/SystemClock";
import type { InfraConfig } from "@config/InfraConfig";
import { parseTimeframeToMs } from "@domain/ports/Clock";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Notifier } from "@domain/ports/Notifier";
import type { PriceFeed } from "@domain/ports/PriceFeed";
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
 * - `analysis`      → LLM + notifier + chart renderer + market data + indicators (the
 *                     last three feed the feedback context providers); no price feeds, no Temporal client
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
  const lessonStore = new PostgresLessonStore(db);
  const lessonEventStore = new PostgresLessonEventStore(db);
  const clock = new SystemClock();

  // notifyLessonPending default — no-op with one-time warn so a missing wiring
  // is observable without crashing.
  let warnedNotifyPending = false;
  const noopNotifyLessonPending: ActivityDeps["notifyLessonPending"] = async () => {
    if (!warnedNotifyPending) {
      warnedNotifyPending = true;
      console.warn(
        "notifyLessonPending no-op invoked. Pending lesson approvals are not being notified.",
      );
    }
  };

  // Placeholder feedback registry — any access throws so a missing wiring
  // is loud. Only the analysis role swaps in the real one below.
  const feedbackContextRegistryPlaceholder: FeedbackContextProviderRegistry = new Proxy(
    {} as FeedbackContextProviderRegistry,
    {
      get() {
        throw new Error(
          "feedbackContextRegistry not wired for this role. " +
            "If you see this in tests, mock feedbackContextRegistry on the test deps directly.",
        );
      },
    },
  );

  const usedSources = new Set(watches.filter((w) => w.enabled).map((w) => w.asset.source));

  // Market data fetchers: scheduler runs the live tracking loop; analysis runs
  // feedback context providers (post-mortem OHLCV + chart). Notification needs
  // none.
  const marketDataFetchers = new Map<string, MarketDataFetcher>();
  if (role === "scheduler" || role === "analysis") {
    if (usedSources.has("binance")) marketDataFetchers.set("binance", new BinanceFetcher());
    if (usedSources.has("yahoo")) marketDataFetchers.set("yahoo", new YahooFinanceFetcher());
  }

  // Chart renderer: scheduler builds setup charts; analysis renders post-mortem
  // charts for the feedback loop.
  let chartRenderer: PlaywrightChartRenderer | null = null;
  if (role === "scheduler") {
    chartRenderer = new PlaywrightChartRenderer({ poolSize: 2 });
    await chartRenderer.warmUp();
  } else if (role === "analysis") {
    chartRenderer = new PlaywrightChartRenderer({ poolSize: 1 });
    await chartRenderer.warmUp();
  }

  const indicatorCalculator =
    role === "scheduler" || role === "analysis" ? new PureJsIndicatorCalculator() : null;

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

  const watchesArr = [...watches];
  const watchById = (id: string) => watchesArr.find((w) => w.id === id);

  let temporalConnection: Connection | null = null;
  let temporalClient: Client | null = null;
  if (role === "scheduler") {
    temporalConnection = await Connection.connect({ address: infra.temporal.address });
    temporalClient = new Client({
      connection: temporalConnection,
      namespace: infra.temporal.namespace,
    });
  }

  // Feedback context registry — wired with the 4 canonical providers on the
  // analysis role only (the only worker that runs feedback activities).
  let feedbackContextRegistry: FeedbackContextProviderRegistry = feedbackContextRegistryPlaceholder;
  if (role === "analysis") {
    const firstFetcher = marketDataFetchers.values().next().value;
    if (!firstFetcher) {
      throw new Error(
        "analysis role requires at least one market_data fetcher configured in watches",
      );
    }
    if (!chartRenderer) {
      throw new Error("analysis role requires chartRenderer (internal wiring bug)");
    }
    feedbackContextRegistry = new FeedbackContextProviderRegistry({
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
  }

  // notifyLessonPending — bridges applyLessonChanges to the user-facing
  // approval channel (telegram inline keyboard) on the analysis role. Other
  // roles keep the no-op (they don't run feedback activities).
  let notifyLessonPending: ActivityDeps["notifyLessonPending"] = noopNotifyLessonPending;
  if (role === "analysis") {
    const lessonProposalNotifier = new TelegramNotifier({
      token: infra.notifications.telegram.bot_token,
    });
    const lessonChatId = infra.notifications.telegram.chat_id;
    notifyLessonPending = async (input) => {
      const { messageId } = await lessonProposalNotifier.sendLessonProposal({
        chatId: lessonChatId,
        lessonId: input.lessonId,
        kind: input.kind,
        watchId: input.watchId,
        category: input.category,
        title: input.title,
        body: input.body,
        rationale: input.rationale,
        triggerSetupId: input.triggerSetupId,
        triggerCloseReason: input.triggerCloseReason,
        before: input.before,
      });
      await lessonEventStore.append({
        watchId: input.watchId,
        lessonId: input.lessonId,
        type: "NotificationSent",
        actor: "system",
        payload: {
          type: "NotificationSent",
          data: { channel: "telegram", msgId: messageId },
        },
      });
    };
  }

  const deps: ActivityDeps = {
    marketDataFetchers,
    chartRenderer: chartRenderer ?? (null as unknown as PlaywrightChartRenderer),
    indicatorCalculator: indicatorCalculator ?? (null as unknown as PureJsIndicatorCalculator),
    llmProviders,
    priceFeeds,
    notifier,
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock,
    config: { watches: watchesArr },
    infra,
    watchById,
    temporalClient: temporalClient ?? (null as unknown as Client),
    db,
    pgPool: pool,
    lessonStore,
    lessonEventStore,
    feedbackContextRegistry,
    notifyLessonPending,
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
