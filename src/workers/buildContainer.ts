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
 * - `analysis`      → LLM + notifier + chart renderer + market data + indicators (the
 *                     last three feed the feedback context providers); no price feeds, no Temporal client
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
  const lessonStore = new PostgresLessonStore(db);
  const lessonEventStore = new PostgresLessonEventStore(db);
  const clock = new SystemClock();

  // notifyLessonPending is wired in the composition root (Phase 13) — at the
  // container level we provide a no-op default; the worker entrypoint can swap
  // it for a Telegram-backed implementation when feedback approvals ship.
  // The first invocation logs a one-time warning so the silent path is observable.
  let warnedNotifyPending = false;
  const noopNotifyLessonPending: ActivityDeps["notifyLessonPending"] = async () => {
    if (!warnedNotifyPending) {
      warnedNotifyPending = true;
      // Use a console.warn here (no logger import) to keep this surface dependency-free;
      // structured logging takes over once Phase 13 wires the real implementation.
      console.warn(
        "notifyLessonPending no-op invoked (Phase 13 pending). " +
          "Pending lesson approvals are not being notified yet — wire a real implementation.",
      );
    }
  };

  // Phase 13 will replace this with the real FeedbackContextProviderRegistry instance.
  // Until then, any access throws so the gap is loud and obvious.
  const feedbackContextRegistryPlaceholder: FeedbackContextProviderRegistry = new Proxy(
    {} as FeedbackContextProviderRegistry,
    {
      get() {
        throw new Error(
          "feedbackContextRegistry not wired (Phase 13 pending). " +
            "If you see this in tests, mock feedbackContextRegistry on the test deps directly.",
        );
      },
    },
  );

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
      eventStore,
      artifactStore,
      tickSnapshotStore,
      clock,
      config: null as unknown as WatchesConfig,
      infra,
      watchById: () => undefined,
      temporalClient: null as unknown as Client,
      db,
      lessonStore,
      lessonEventStore,
      feedbackContextRegistry: feedbackContextRegistryPlaceholder,
      notifyLessonPending: noopNotifyLessonPending,
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
  // Market data fetchers: scheduler runs the live tracking loop; analysis runs
  // feedback context providers (post-mortem OHLCV + chart). Notification needs
  // none.
  const marketDataFetchers = new Map<string, MarketDataFetcher>();
  if (role === "scheduler" || role === "analysis") {
    if (watches.market_data.includes("binance")) {
      marketDataFetchers.set("binance", new BinanceFetcher());
    }
    if (watches.market_data.includes("yahoo")) {
      marketDataFetchers.set("yahoo", new YahooFinanceFetcher());
    }
  }

  // Chart renderer: scheduler builds setup charts; analysis renders post-mortem
  // charts for the feedback loop. Smaller pool on analysis (one chart per
  // feedback run, not per scheduler tick).
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

  const watchById = (id: string) => watches.watches.find((w) => w.id === id);

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
  // analysis role (the only worker that runs feedback activities). Other roles
  // keep the throwing placeholder: they should never call
  // `gatherFeedbackContext`, and a loud failure if they do is preferable to a
  // silent no-op.
  //
  // Per-watch MarketDataFetcher selection: each watch has `asset.source`
  // (`binance` | `yahoo`) and the registry stores a single fetcher per
  // provider. We mirror the CLI adapter (`src/cli/_feedback-adapters.ts`):
  // wire the FIRST configured fetcher. Workflows execute against one watch at
  // a time; if both `binance` and `yahoo` watches are mixed in the same
  // config, the chosen fetcher will reject unknown symbols loudly. A future
  // refactor could pass the fetcher map and dispatch by `scope.asset` inside
  // each provider — out of scope for v1.
  let feedbackContextRegistry: FeedbackContextProviderRegistry = feedbackContextRegistryPlaceholder;
  if (role === "analysis") {
    const firstFetcher = marketDataFetchers.values().next().value;
    if (!firstFetcher) {
      throw new Error(
        "analysis role requires at least one market_data fetcher configured in watches.yaml",
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
  // approval channel. On the analysis role with telegram enabled we send the
  // inline-keyboard proposal and persist a NotificationSent lesson_event so
  // the notification-worker callback handler can later edit the message in
  // place (see Task 38 / notification-worker.ts). Other roles keep the no-op
  // (they don't run feedback activities).
  let notifyLessonPending: ActivityDeps["notifyLessonPending"] = noopNotifyLessonPending;
  if (role === "analysis" && watches.notifications.telegram) {
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
    notifier: effectiveNotifier,
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock,
    config: watches,
    infra,
    watchById,
    temporalClient: temporalClient ?? (null as unknown as Client),
    db,
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
