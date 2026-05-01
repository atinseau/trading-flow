import type { FeedbackContextProviderRegistry } from "@adapters/feedback-context/FeedbackContextProviderRegistry";
import type { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import type { InfraConfig } from "@config/InfraConfig";
import type { ArtifactStore } from "@domain/ports/ArtifactStore";
import type { ChartRenderer } from "@domain/ports/ChartRenderer";
import type { Clock } from "@domain/ports/Clock";
import type { EventStore } from "@domain/ports/EventStore";
import type { FundingRateProvider } from "@domain/ports/FundingRateProvider";
import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { LessonEventStore } from "@domain/ports/LessonEventStore";
import type { LessonStore } from "@domain/ports/LessonStore";
import type { LLMCallStore } from "@domain/ports/LLMCallStore";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Notifier } from "@domain/ports/Notifier";
import type { PriceFeed } from "@domain/ports/PriceFeed";
import type { ScheduleController } from "@domain/ports/ScheduleController";
import type { SetupRepository } from "@domain/ports/SetupRepository";
import type { TickSnapshotStore } from "@domain/ports/TickSnapshotStore";
import type { WatchRepository } from "@domain/ports/WatchRepository";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { PromptBuilder } from "@domain/services/PromptBuilder";
import type { Client } from "@temporalio/client";
import type { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

export type NotifyLessonPendingInput = {
  lessonId: string;
  watchId: string;
  category: "detecting" | "reviewing" | "finalizing";
  title: string;
  body: string;
  rationale: string;
  kind: "CREATE" | "REFINE";
  before?: { title: string; body: string };
  triggerSetupId: string;
  triggerCloseReason: string;
};

export type ActivityDeps = {
  marketDataFetchers: Map<string, MarketDataFetcher>;
  chartRenderer: ChartRenderer;
  indicatorCalculator: IndicatorCalculator;
  indicatorRegistry: IndicatorRegistry;
  promptBuilder: PromptBuilder;
  llmProviders: Map<string, LLMProvider>;
  llmCallStore: LLMCallStore;
  /**
   * Crypto-perp funding/OI providers keyed by source. Optional for non-crypto
   * watches; reviewer/finalizer skip the funding block when null is returned
   * or no provider is registered for the watch's source.
   */
  fundingRateProviders: Map<string, FundingRateProvider>;
  priceFeeds: Map<string, PriceFeed>;
  notifier: Notifier;
  setupRepo: SetupRepository;
  watchRepo: WatchRepository;
  eventStore: EventStore;
  artifactStore: ArtifactStore;
  tickSnapshotStore: TickSnapshotStore;
  clock: Clock;
  config: { watches: WatchConfig[] };
  infra: InfraConfig;
  watchById: (id: string) => Promise<WatchConfig | null>;
  temporalClient: Client;
  scheduleController: ScheduleController;
  db: ReturnType<typeof drizzle>;
  pgPool: pg.Pool;
  // --- Feedback loop deps ---
  lessonStore: LessonStore;
  lessonEventStore: LessonEventStore;
  feedbackContextRegistry: FeedbackContextProviderRegistry;
  /**
   * Inline async callback (NOT a Temporal activity) invoked from
   * `applyLessonChanges` for CREATE/REFINE proposals. Wired to the Telegram
   * notifier in the composition root. For tests, can be replaced with a
   * capture stub.
   */
  notifyLessonPending: (input: NotifyLessonPendingInput) => Promise<void>;
};
