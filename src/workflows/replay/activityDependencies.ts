import type { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import type { ArtifactStore } from "@domain/ports/ArtifactStore";
import type { ChartRenderer } from "@domain/ports/ChartRenderer";
import type { FundingRateProvider } from "@domain/ports/FundingRateProvider";
import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { LessonStore } from "@domain/ports/LessonStore";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { LLMResponseCacheStore } from "@domain/ports/LLMResponseCacheStore";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { ReplayEventStore } from "@domain/ports/ReplayEventStore";
import type { ReplayLLMCallStore } from "@domain/ports/ReplayLLMCallStore";
import type { ReplaySessionRepository } from "@domain/ports/ReplaySessionRepository";
import type { PromptBuilder } from "@domain/services/PromptBuilder";

/**
 * Dependencies for the replay-dedicated activities (Strategy 3: controlled
 * duplication of the live activities, no inline DI branching).
 *
 * - Live read-only ports are reused (fetchers, chart renderer, indicator
 *   calculator, artifact store, prompt builder, llm providers, lesson store
 *   for read access). The replay activities NEVER mutate the live event
 *   store, setup repository, tick snapshot store, or lesson store.
 * - Replay-scoped writes go to `replayEventStore`, `replayLlmCallStore`
 *   and `sessionsRepo.incrementCost`.
 * - `cacheStore` is the mutualized LLM response cache; activities wrap the
 *   live providers in `CachedLLMProvider` at call time.
 *
 * Notifier is intentionally absent: replay does not emit Telegram messages;
 * captured previews land in `replay_events` payloads via dedicated activities
 * added by Phase 8+.
 */
export type ReplayActivityDeps = {
  marketDataFetchers: Map<string, MarketDataFetcher>;
  chartRenderer: ChartRenderer;
  indicatorCalculator: IndicatorCalculator;
  indicatorRegistry: IndicatorRegistry;
  promptBuilder: PromptBuilder;
  artifactStore: ArtifactStore;
  fundingRateProviders: Map<string, FundingRateProvider>;
  llmProviders: Map<string, LLMProvider>;
  lessonStore: LessonStore;

  sessionsRepo: ReplaySessionRepository;
  replayEventStore: ReplayEventStore;
  replayLlmCallStore: ReplayLLMCallStore;
  cacheStore: LLMResponseCacheStore;
};
