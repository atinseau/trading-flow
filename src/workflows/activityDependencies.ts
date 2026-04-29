import type { FeedbackContextProviderRegistry } from "@adapters/feedback-context/FeedbackContextProviderRegistry";
import type { InfraConfig } from "@config/InfraConfig";
import type { ArtifactStore } from "@domain/ports/ArtifactStore";
import type { ChartRenderer } from "@domain/ports/ChartRenderer";
import type { Clock } from "@domain/ports/Clock";
import type { EventStore } from "@domain/ports/EventStore";
import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { LessonEventStore } from "@domain/ports/LessonEventStore";
import type { LessonStore } from "@domain/ports/LessonStore";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Notifier } from "@domain/ports/Notifier";
import type { PriceFeed } from "@domain/ports/PriceFeed";
import type { SetupRepository } from "@domain/ports/SetupRepository";
import type { TickSnapshotStore } from "@domain/ports/TickSnapshotStore";
import type { WatchConfig, WatchesConfig } from "@domain/schemas/WatchesConfig";
import type { Client } from "@temporalio/client";
import type { drizzle } from "drizzle-orm/node-postgres";

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
  llmProviders: Map<string, LLMProvider>;
  priceFeeds: Map<string, PriceFeed>;
  notifier: Notifier;
  setupRepo: SetupRepository;
  eventStore: EventStore;
  artifactStore: ArtifactStore;
  tickSnapshotStore: TickSnapshotStore;
  clock: Clock;
  config: WatchesConfig;
  infra: InfraConfig;
  watchById: (id: string) => WatchConfig | undefined;
  temporalClient: Client;
  db: ReturnType<typeof drizzle>;
  // --- Feedback loop deps (Phase 7+) ---
  lessonStore: LessonStore;
  lessonEventStore: LessonEventStore;
  feedbackContextRegistry: FeedbackContextProviderRegistry;
  /**
   * Inline async callback (NOT a Temporal activity) invoked from
   * `applyLessonChanges` for CREATE/REFINE proposals. Wired to the Telegram
   * notifier in the composition root (Phase 13). For tests, can be replaced
   * with a capture stub.
   */
  notifyLessonPending: (input: NotifyLessonPendingInput) => Promise<void>;
};
