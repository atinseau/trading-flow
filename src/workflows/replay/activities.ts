import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import { FixedClock } from "@adapters/time/FixedClock";
import { InvalidConfigError } from "@domain/errors";
import { extractObservations, extractReasoning } from "@domain/events/payloadAccessors";
import type { CloseReason } from "@domain/feedback/closeOutcome";
import type { LessonAction, LessonCategory } from "@domain/feedback/lessonAction";
import type { NewReplayEvent, StoredReplayEvent } from "@domain/ports/ReplayEventStore";
import { filterLessonsForReplay, type LessonLike } from "@domain/replay/lessonsLookup";
import type { ReplaySession } from "@domain/replay/ReplaySession";
import { buildDetectorOutputSchema } from "@domain/schemas/DetectorOutput";
import { type FeedbackOutput, FeedbackOutputSchema } from "@domain/schemas/FeedbackOutput";
import { buildIndicatorsSchema } from "@domain/schemas/Indicators";
import { type ReviewerLlmOutput, ReviewerLlmOutputSchema } from "@domain/schemas/ReviewerOutput";
import { type Verdict, VerdictSchema } from "@domain/schemas/Verdict";
import { computeHtfContext } from "@domain/services/htfContext";
import { renderHtfChart } from "@domain/services/htfChartRenderer";
import { inferImageMimeType } from "@domain/services/imageMimeType";
import { classifyRegime } from "@domain/services/marketRegime";
import { getTradingSession } from "@domain/services/tradingSession";
import { getLogger } from "@observability/logger";
import { z } from "zod";
import type { ReplayActivityDeps } from "./activityDependencies";
import { wrapLlmProvidersWithCache } from "./wrapLlmProvidersWithCache";

const log = getLogger({ component: "replay-activities" });

/**
 * Heuristic for distinguishing a cache hit from a live LLM call. The
 * `CachedLLMProvider` returns `costUsd: 0` AND `latencyMs: 0` on every hit;
 * a real provider call always reports a positive latency even if its cost
 * happens to be zero. Both conditions together are the unambiguous signal.
 */
function wasCacheHit(out: { costUsd: number; latencyMs: number }): boolean {
  return out.costUsd === 0 && out.latencyMs === 0;
}

/**
 * Plain-JSON view of a `Setup` the replay workflow can hand to an activity
 * without depending on the live `setups` table. Subset of the entity
 * containing only fields the reviewer/finalizer prompts need. Workflow
 * builds this from the replay-events projection.
 */
export type ReplaySetupSnapshot = {
  id: string;
  watchId: string;
  asset: string;
  timeframe: string;
  patternHint: string | null;
  patternCategory: "event" | "accumulation" | null;
  expectedMaturationTicks: number | null;
  direction: "LONG" | "SHORT" | null;
  currentScore: number;
  invalidationLevel: number | null;
};

// --- Detector ----------------------------------------------------------------

export type RunDetectorReplayInput = {
  sessionId: string;
  /** ISO string — Temporal serializes Date as string across the activity boundary. */
  tickAt: string;
  /**
   * Alive setups for the watch at `tickAt`, computed by the workflow from
   * the replay-events projection. Same shape the live activity gets from
   * `setupRepo.listAlive`; the activity just forwards it into the prompt.
   */
  aliveSetups: unknown[];
};

export type RunDetectorReplayResult = {
  /** JSON-encoded `DetectorOutput`. Empty string when the detector produced nothing parseable. */
  verdictJson: string;
  /** URI of the chart artifact rendered for this tick (content-addressable). */
  chartUri: string;
  /** URI of the persisted OHLCV slice (for downstream stages). */
  ohlcvUri: string;
  /** JSON-encoded indicators map (scalars). */
  indicatorsJson: string;
  /** Close of the last candle in the window — used as the "live" price downstream. */
  lastClose: number;
  costUsd: number;
  promptVersion: string;
  cacheHit: boolean;
};

// --- Reviewer ----------------------------------------------------------------

export type RunReviewerReplayInput = {
  sessionId: string;
  tickAt: string;
  setup: ReplaySetupSnapshot;
  /** Chart artifact URI captured at the detector tick. */
  chartUri: string;
  /** Indicators captured at the detector tick. */
  indicatorsJson: string;
  /** Last close at the detector tick — used as the live price for HTF context. */
  lastClose: number;
};

export type RunReviewerReplayResult = {
  /** JSON-encoded `Verdict` (post strip of `request_additional`). */
  verdictJson: string;
  costUsd: number;
  promptVersion: string;
  provider: string;
  model: string;
  cacheHit: boolean;
};

// --- Finalizer ---------------------------------------------------------------

export type RunFinalizerReplayInput = {
  sessionId: string;
  tickAt: string;
  setup: ReplaySetupSnapshot;
  /** Most recent indicators (same tick used for reviewer). */
  latestIndicatorsJson: string;
  /** Live price at the finalizer tick. */
  latestLastClose: number;
};

export type RunFinalizerReplayResult = {
  /** JSON-encoded `{ go: boolean; reasoning: string; entry?, stop_loss?, take_profit? }`. */
  decisionJson: string;
  costUsd: number;
  promptVersion: string;
  provider: string;
  model: string;
  cacheHit: boolean;
};

const FinalizerOutputSchema = z.object({
  go: z.boolean(),
  reasoning: z.string(),
  entry: z.number().optional(),
  stop_loss: z.number().optional(),
  take_profit: z.array(z.number()).optional(),
});

// --- Feedback analysis ------------------------------------------------------

export type RunFeedbackAnalysisReplayInput = {
  sessionId: string;
  setupId: string;
  /**
   * Simulated time at which the setup closed. Used as `occurredAt` for
   * the persisted `FeedbackLessonProposed` events so the timeline stays
   * deterministic — same input → same event timestamps → cache friendly.
   */
  tickAt: string;
  /** Why the setup closed (from the replay-events projection). */
  closeReason: CloseReason;
  /** Whether the setup ever transitioned to CONFIRMED before closing. */
  everConfirmed: boolean;
  /** Setup score at the moment of close. */
  scoreAtClose: number;
};

export type RunFeedbackAnalysisReplayResult = {
  /** No-op marker when `feedbackMode === "skip"` — nothing was called. */
  skipped: boolean;
  /** Bot's textual summary of the trade post-mortem. */
  summary: string;
  /** Proposed lesson actions. Always empty when `skipped: true`. */
  actions: LessonAction[];
  costUsd: number;
  promptVersion: string;
  provider: string;
  model: string;
  cacheHit: boolean;
};

// --- Workflow plumbing -------------------------------------------------------

export type AppendReplayEventInput = {
  sessionId: string;
  event: NewReplayEvent;
};

export type LoadReplaySessionResult = {
  session: ReplaySession;
};

export type ReplayActivities = ReturnType<typeof buildReplayActivities>;

export function buildReplayActivities(deps: ReplayActivityDeps) {
  /**
   * Shared helper — fetches active lessons for a given category and applies
   * the session's `lessonsMode` filter without mutating live usage stats.
   */
  async function loadLessonsForReplay(args: {
    watchId: string;
    category: "detecting" | "reviewing" | "finalizing";
    cap: number;
    lessonsMode: "current" | "historical" | "disabled";
    windowStartAt: Date;
    injection: boolean;
  }): Promise<Array<{ id: string; title: string; body: string }>> {
    if (!args.injection || args.lessonsMode === "disabled") return [];
    const raw = await deps.lessonStore.listByStatus({
      watchId: args.watchId,
      category: args.category,
    });
    const compat: LessonLike[] = raw.map((l) => ({
      id: l.id,
      watchId: l.watchId,
      status: l.status,
      activatedAt: l.activatedAt,
      deprecatedAt: l.deprecatedAt,
    }));
    const filtered = filterLessonsForReplay(compat, args.lessonsMode, args.windowStartAt);
    const byId = new Map(raw.map((l) => [l.id, l]));
    return filtered
      .slice(0, args.cap)
      .map((l) => byId.get(l.id))
      .filter((l): l is NonNullable<typeof l> => l !== undefined)
      .map((l) => ({ id: l.id, title: l.title, body: l.body }));
  }

  return {
    /**
     * Replay-mode detector tick — see file header for the full contract.
     */
    async runDetectorReplay(input: RunDetectorReplayInput): Promise<RunDetectorReplayResult> {
      const tickAt = new Date(input.tickAt);
      const session = await deps.sessionsRepo.get(input.sessionId);
      if (!session) throw new Error(`Replay session ${input.sessionId} not found`);

      const watch = session.configSnapshot;
      const childLog = log.child({
        sessionId: input.sessionId,
        watchId: session.watchId,
        tickAt: tickAt.toISOString(),
      });

      const fetcher = deps.marketDataFetchers.get(watch.asset.source);
      if (!fetcher) throw new InvalidConfigError(`No fetcher for source ${watch.asset.source}`);
      const candles = await fetcher.fetchOHLCV({
        asset: watch.asset.symbol,
        timeframe: watch.timeframes.primary,
        limit: watch.candles.detector_lookback,
        endTime: tickAt,
      });
      if (candles.length === 0) {
        throw new Error(`No OHLCV data returned ending at ${tickAt.toISOString()}`);
      }
      const ohlcvJson = JSON.stringify(candles);
      const ohlcvStored = await deps.artifactStore.put({
        kind: "ohlcv_snapshot",
        content: Buffer.from(ohlcvJson, "utf8"),
        mimeType: "application/json",
      });

      const plugins = deps.indicatorRegistry.resolveActive(watch.indicators);
      const paramsByPlugin: Record<string, Record<string, unknown>> = {};
      for (const p of plugins) {
        const cfg = watch.indicators[p.id];
        paramsByPlugin[p.id] =
          (cfg?.params as Record<string, unknown>) ??
          (p.defaultParams as Record<string, unknown>) ??
          {};
      }
      const scalars = await deps.indicatorCalculator.compute(candles, plugins, paramsByPlugin);
      const indicators = buildIndicatorsSchema(plugins).parse(scalars);

      const slice = candles.slice(-watch.candles.reviewer_chart_window);
      const series = await deps.indicatorCalculator.computeSeries(slice, plugins, paramsByPlugin);
      const enabledIds = plugins.map((p) => p.id);
      const naked = enabledIds.length === 0;
      const secondaryPaneCount = plugins.filter((p) => p.chartPane === "secondary").length;
      const height = naked
        ? 900
        : secondaryPaneCount >= 3
          ? 1080
          : secondaryPaneCount >= 1
            ? 720
            : 900;
      const tempUri = `file:///tmp/replay-chart-${crypto.randomUUID()}.png`;
      const rendered = await deps.chartRenderer.render({
        candles: slice,
        series,
        enabledIndicatorIds: enabledIds,
        width: 1280,
        height,
        outputUri: tempUri,
      });
      const chartStored = await deps.artifactStore.put({
        kind: "chart_image",
        content: rendered.content,
        mimeType: rendered.mimeType,
      });

      const activeLessons = await loadLessonsForReplay({
        watchId: session.watchId,
        category: "detecting",
        cap: watch.feedback.max_active_lessons_per_category,
        lessonsMode: session.lessonsMode,
        windowStartAt: session.windowStartAt,
        injection: watch.feedback.injection.detector,
      });

      await deps.promptBuilder.warmUp();
      const htfEnabled = watch.timeframes.higher.length > 0;
      const detectorOutputSchema = buildDetectorOutputSchema(plugins, htfEnabled);
      const userPrompt = await deps.promptBuilder.buildDetectorPrompt({
        asset: watch.asset.symbol,
        timeframe: watch.timeframes.primary,
        tickAt,
        scalars: indicators as unknown as Record<string, unknown>,
        aliveSetups: input.aliveSetups,
        activeLessons: activeLessons.map((l) => ({ title: l.title, body: l.body })),
        indicatorsMatrix: watch.indicators,
      });

      const wrappedProviders = wrapLlmProvidersWithCache(
        deps.llmProviders,
        deps.cacheStore,
        deps.promptBuilder.detectorVersion,
      );
      const result = await resolveAndCall(
        watch.analyzers.detector.provider,
        {
          systemPrompt: deps.promptBuilder.detectorSystemPrompt,
          userPrompt,
          images: [{ sourceUri: chartStored.uri, mimeType: "image/png" }],
          model: watch.analyzers.detector.model,
          maxTokens: watch.analyzers.detector.max_tokens,
          responseSchema: detectorOutputSchema,
        },
        wrappedProviders,
      );

      const cacheHit = wasCacheHit(result.output);
      const promptVersion = deps.promptBuilder.detectorVersion;

      await deps.replayLlmCallStore.record({
        sessionId: input.sessionId,
        setupId: null,
        stage: "detector",
        provider: result.usedProvider,
        model: watch.analyzers.detector.model,
        promptTokens: result.output.promptTokens,
        completionTokens: result.output.completionTokens,
        cacheReadTokens: result.output.cacheReadTokens ?? 0,
        cacheCreateTokens: result.output.cacheWriteTokens ?? 0,
        costUsd: result.output.costUsd,
        latencyMs: result.output.latencyMs,
        cacheHit,
      });

      if (!cacheHit && result.output.costUsd > 0) {
        await deps.sessionsRepo.incrementCost(input.sessionId, result.output.costUsd);
      }

      const parsed = (result.output.parsed ?? null) as {
        ignore_reason?: string | null;
        new_setups?: unknown[];
      } | null;
      const ignoreReason = parsed?.ignore_reason ?? null;
      await deps.replayEventStore.append(input.sessionId, {
        setupId: null,
        occurredAt: tickAt,
        stage: "detector",
        actor: result.usedProvider,
        type: "DetectorTickProcessed",
        scoreDelta: 0,
        payload: {
          type: "DetectorTickProcessed",
          data: { ignoreReason },
        },
        provider: result.usedProvider,
        model: watch.analyzers.detector.model,
        promptVersion,
        latencyMs: result.output.latencyMs,
        cacheHit,
      });

      const lastClose = candles[candles.length - 1]?.close ?? 0;
      childLog.info(
        {
          costUsd: result.output.costUsd,
          cacheHit,
          newSetups: Array.isArray(parsed?.new_setups) ? parsed.new_setups.length : 0,
        },
        "runDetectorReplay complete",
      );

      return {
        verdictJson: JSON.stringify(result.output.parsed ?? {}),
        chartUri: chartStored.uri,
        ohlcvUri: ohlcvStored.uri,
        indicatorsJson: JSON.stringify(indicators),
        lastClose,
        costUsd: result.output.costUsd,
        promptVersion,
        cacheHit,
      };
    },

    /**
     * Replay-mode reviewer tick. The orchestrating workflow has already
     * decided this setup is alive and reviewable; the activity just builds
     * the prompt, calls the LLM, and returns the verdict.
     *
     * Differences vs. live `runReviewer`:
     *  - No market-hours guard. Replay = user-controlled stepping; we don't
     *    skip "closed market" ticks because the user explicitly picked
     *    them.
     *  - History is sourced from `replay_events` filtered by setup.id, not
     *    the live event store.
     *  - HTF context is fetched with `endTime = tickAt` to keep the replay
     *    deterministic.
     *  - HTF round-2 chart reload (the tool-call pattern) is intentionally
     *    NOT implemented yet — the wire field `request_additional` is
     *    discarded just like in live. Adding the second round is a future
     *    follow-up; not blocking for J2 first-pass.
     *  - Returns the persisted verdict only; the workflow handles event
     *    persistence to `replay_events` (mirrors live separation).
     */
    async runReviewerReplay(input: RunReviewerReplayInput): Promise<RunReviewerReplayResult> {
      const tickAt = new Date(input.tickAt);
      const session = await deps.sessionsRepo.get(input.sessionId);
      if (!session) throw new Error(`Replay session ${input.sessionId} not found`);
      const watch = session.configSnapshot;
      const childLog = log.child({
        sessionId: input.sessionId,
        setupId: input.setup.id,
        tickAt: tickAt.toISOString(),
      });

      await deps.promptBuilder.warmUp();

      // History scoped to this setup, in sequence order.
      const allEvents = await deps.replayEventStore.listBySession(input.sessionId);
      const history = allEvents
        .filter((e) => e.setupId === input.setup.id)
        .sort((a, b) => a.sequence - b.sequence);

      const activeLessons = await loadLessonsForReplay({
        watchId: session.watchId,
        category: "reviewing",
        cap: watch.feedback.max_active_lessons_per_category,
        lessonsMode: session.lessonsMode,
        windowStartAt: session.windowStartAt,
        injection: watch.feedback.injection.reviewer,
      });

      const indicators = JSON.parse(input.indicatorsJson) as Record<string, unknown>;
      const reviewerFetcher = deps.marketDataFetchers.get(watch.asset.source);
      const htf = reviewerFetcher
        ? await computeHtfContext({
            marketDataFetcher: reviewerFetcher,
            asset: watch.asset.symbol,
            livePrice: input.lastClose,
            endTime: tickAt,
          })
        : null;

      const fundingProvider = deps.fundingRateProviders.get(watch.asset.source);
      const funding = fundingProvider
        ? await fundingProvider.fetchSnapshot(watch.asset.symbol).catch(() => null)
        : null;

      const userPrompt = await deps.promptBuilder.buildReviewerPrompt({
        setup: {
          id: input.setup.id,
          patternHint: input.setup.patternHint,
          direction: input.setup.direction,
          currentScore: input.setup.currentScore,
          invalidationLevel: input.setup.invalidationLevel,
          ageInCandles: 0,
        },
        history: history.map((e) => ({
          sequence: e.sequence,
          occurredAt: e.occurredAt.toISOString(),
          scoreAfter: e.scoreAfter,
          type: e.type,
          observations: extractObservations(e.payload),
          reasoning: extractReasoning(e.payload),
        })),
        fresh: { lastClose: input.lastClose, scalars: indicators, tickAt },
        htf,
        funding,
        activeLessons: activeLessons.map((l) => ({ title: l.title, body: l.body })),
        indicatorsMatrix: watch.indicators,
      });

      const wrappedProviders = wrapLlmProvidersWithCache(
        deps.llmProviders,
        deps.cacheStore,
        deps.promptBuilder.reviewerVersion,
      );
      const round1Images = [
        { sourceUri: input.chartUri, mimeType: inferImageMimeType(input.chartUri) },
      ];
      const round1 = await resolveAndCall(
        watch.analyzers.reviewer.provider,
        {
          systemPrompt: deps.promptBuilder.reviewerSystemPrompt,
          userPrompt,
          images: round1Images,
          model: watch.analyzers.reviewer.model,
          maxTokens: watch.analyzers.reviewer.max_tokens,
          responseSchema: ReviewerLlmOutputSchema,
        },
        wrappedProviders,
      );

      const cacheHit = wasCacheHit(round1.output);
      const promptVersion = deps.promptBuilder.reviewerVersion;

      await deps.replayLlmCallStore.record({
        sessionId: input.sessionId,
        setupId: input.setup.id,
        stage: "reviewer",
        provider: round1.usedProvider,
        model: watch.analyzers.reviewer.model,
        promptTokens: round1.output.promptTokens,
        completionTokens: round1.output.completionTokens,
        cacheReadTokens: round1.output.cacheReadTokens ?? 0,
        cacheCreateTokens: round1.output.cacheWriteTokens ?? 0,
        costUsd: round1.output.costUsd,
        latencyMs: round1.output.latencyMs,
        cacheHit,
      });
      if (!cacheHit && round1.output.costUsd > 0) {
        await deps.sessionsRepo.incrementCost(input.sessionId, round1.output.costUsd);
      }

      // Strip request_additional before persisting — the HTF round-2 reload
      // is not yet implemented in replay (see method docstring). Live mirrors
      // this strip after the optional round-2 run.
      const llmOut = round1.output.parsed as ReviewerLlmOutput;
      const { request_additional: _unused, ...persistedFields } = llmOut;
      const verdict = VerdictSchema.parse(persistedFields) as Verdict;

      childLog.info(
        {
          verdict: verdict.type,
          costUsd: round1.output.costUsd,
          cacheHit,
        },
        "runReviewerReplay complete",
      );

      return {
        verdictJson: JSON.stringify(verdict),
        costUsd: round1.output.costUsd,
        promptVersion,
        provider: round1.usedProvider,
        model: watch.analyzers.reviewer.model,
        cacheHit,
      };
    },

    /**
     * Replay-mode finalizer tick. The gatekeeper that turns a high-confidence
     * setup into a GO/NO_GO decision. Mirrors live `runFinalizer` ; the
     * workflow persists `Confirmed`/`Rejected` to `replay_events` from the
     * returned decision.
     *
     * Differences vs. live `runFinalizer`:
     *  - Setup state is provided by the workflow as a snapshot (no
     *    `setupRepo` access in replay).
     *  - History is sourced from `replay_events` filtered by setup.id.
     *  - "Latest indicators" come from the most recent detector tick (workflow
     *    threads them through), not a live `tick_snapshots` row.
     *  - HTF context + chart are rendered with `endTime = tickAt`.
     *  - No market-hours guard (see `runReviewerReplay`).
     */
    async runFinalizerReplay(input: RunFinalizerReplayInput): Promise<RunFinalizerReplayResult> {
      const tickAt = new Date(input.tickAt);
      const session = await deps.sessionsRepo.get(input.sessionId);
      if (!session) throw new Error(`Replay session ${input.sessionId} not found`);
      const watch = session.configSnapshot;
      const childLog = log.child({
        sessionId: input.sessionId,
        setupId: input.setup.id,
        tickAt: tickAt.toISOString(),
      });

      const allEvents = await deps.replayEventStore.listBySession(input.sessionId);
      const history = allEvents
        .filter((e) => e.setupId === input.setup.id)
        .sort((a, b) => a.sequence - b.sequence);

      const activeLessons = await loadLessonsForReplay({
        watchId: session.watchId,
        category: "finalizing",
        cap: watch.feedback.max_active_lessons_per_category,
        lessonsMode: session.lessonsMode,
        windowStartAt: session.windowStartAt,
        injection: watch.feedback.injection.finalizer,
      });

      const finalizerFetcher = deps.marketDataFetchers.get(watch.asset.source);
      const htf = finalizerFetcher
        ? await computeHtfContext({
            marketDataFetcher: finalizerFetcher,
            asset: watch.asset.symbol,
            livePrice: input.latestLastClose,
            endTime: tickAt,
          })
        : null;
      let htfChartUri: string | null = null;
      if (finalizerFetcher) {
        try {
          htfChartUri = await renderHtfChart({
            chartRenderer: deps.chartRenderer,
            indicatorCalculator: deps.indicatorCalculator,
            indicatorRegistry: deps.indicatorRegistry,
            artifactStore: deps.artifactStore,
            fetcher: finalizerFetcher,
            asset: watch.asset.symbol,
            endTime: tickAt,
          });
        } catch (_err) {
          // Same defensive handling as the live finalizer.
          htfChartUri = null;
        }
      }

      const fundingProvider = deps.fundingRateProviders.get(watch.asset.source);
      const funding = fundingProvider
        ? await fundingProvider.fetchSnapshot(watch.asset.symbol).catch(() => null)
        : null;

      const latestIndicators = JSON.parse(input.latestIndicatorsJson) as Record<string, unknown>;
      const regime = classifyRegime(latestIndicators, htf);
      const tradingSession = getTradingSession(tickAt);

      const finalizerPrompt = await loadPrompt("finalizer");
      const actualReviewerTicks = history.filter((e) =>
        ["Strengthened", "Weakened", "Neutral"].includes(e.type),
      ).length;

      const minRR = watch.setup_lifecycle.min_risk_reward_ratio;
      const costs = {
        fees_pct: watch.costs.fees_pct,
        slippage_pct: watch.costs.slippage_pct,
        totalPct: (watch.costs.fees_pct + watch.costs.slippage_pct).toFixed(3),
      };

      const userPrompt = finalizerPrompt.render({
        setup: {
          id: input.setup.id,
          asset: input.setup.asset,
          timeframe: input.setup.timeframe,
          patternHint: input.setup.patternHint,
          patternCategory: input.setup.patternCategory,
          expectedMaturationTicks: input.setup.expectedMaturationTicks ?? "(not declared)",
          direction: input.setup.direction,
          currentScore: input.setup.currentScore,
          invalidationLevel: input.setup.invalidationLevel,
        },
        minRiskRewardRatio: minRR,
        costs,
        historyCount: history.length,
        actualReviewerTicks,
        history: history.map((e) => ({
          sequence: e.sequence,
          type: e.type,
          scoreAfter: e.scoreAfter,
        })),
        htf,
        funding,
        regime,
        session: tradingSession,
        activeLessons: activeLessons.map((l) => ({ title: l.title, body: l.body })),
      });

      const wrappedProviders = wrapLlmProvidersWithCache(
        deps.llmProviders,
        deps.cacheStore,
        finalizerPrompt.version,
      );
      const images = htfChartUri
        ? [{ sourceUri: htfChartUri, mimeType: inferImageMimeType(htfChartUri) }]
        : undefined;
      const result = await resolveAndCall(
        watch.analyzers.finalizer.provider,
        {
          systemPrompt: finalizerPrompt.systemPrompt,
          userPrompt,
          images,
          model: watch.analyzers.finalizer.model,
          maxTokens: watch.analyzers.finalizer.max_tokens,
          responseSchema: FinalizerOutputSchema,
        },
        wrappedProviders,
      );

      const cacheHit = wasCacheHit(result.output);
      await deps.replayLlmCallStore.record({
        sessionId: input.sessionId,
        setupId: input.setup.id,
        stage: "finalizer",
        provider: result.usedProvider,
        model: watch.analyzers.finalizer.model,
        promptTokens: result.output.promptTokens,
        completionTokens: result.output.completionTokens,
        cacheReadTokens: result.output.cacheReadTokens ?? 0,
        cacheCreateTokens: result.output.cacheWriteTokens ?? 0,
        costUsd: result.output.costUsd,
        latencyMs: result.output.latencyMs,
        cacheHit,
      });
      if (!cacheHit && result.output.costUsd > 0) {
        await deps.sessionsRepo.incrementCost(input.sessionId, result.output.costUsd);
      }

      const decision = result.output.parsed as { go: boolean };
      childLog.info(
        { go: decision.go, costUsd: result.output.costUsd, cacheHit },
        "runFinalizerReplay complete",
      );

      return {
        decisionJson: JSON.stringify(result.output.parsed),
        costUsd: result.output.costUsd,
        promptVersion: finalizerPrompt.version,
        provider: result.usedProvider,
        model: watch.analyzers.finalizer.model,
        cacheHit,
      };
    },

    /**
     * Replay-mode feedback analysis on trade close. Fires only when the
     * session's `feedbackMode === "run"` ; in `"skip"` mode this is a
     * no-op (no LLM, no events, `skipped: true`).
     *
     * Mirrors the live `runFeedbackAnalysis` + `applyLessonChanges` chain
     * with two replay-specific isolations :
     *
     *  - "Existing lessons" shown to the LLM are filtered via the session's
     *    `lessonsMode` + `windowStartAt` (same isolation as detector /
     *    reviewer / finalizer).
     *  - Proposed actions are persisted as `FeedbackLessonProposed` events
     *    into `replay_events`. They are NEVER written to the live
     *    `lessons` / `lesson_events` tables ; promotion to prod is a
     *    manual, user-driven step on the replay UI.
     *
     * The feedback "context" passed to the LLM is minimal in this first
     * pass — no chart / event-stream chunks. The bare close outcome +
     * score + existing-lessons pool is enough to exercise the feedback
     * loop's end-to-end shape for J2 ; richer context (replay-scoped
     * event projections, chart artifacts at close) is a J3 follow-up.
     */
    async runFeedbackAnalysisReplay(
      input: RunFeedbackAnalysisReplayInput,
    ): Promise<RunFeedbackAnalysisReplayResult> {
      const session = await deps.sessionsRepo.get(input.sessionId);
      if (!session) throw new Error(`Replay session ${input.sessionId} not found`);
      const watch = session.configSnapshot;
      const childLog = log.child({
        sessionId: input.sessionId,
        setupId: input.setupId,
      });

      if (session.feedbackMode === "skip") {
        childLog.info({}, "runFeedbackAnalysisReplay skipped (feedbackMode=skip)");
        return {
          skipped: true,
          summary: "",
          actions: [],
          costUsd: 0,
          promptVersion: "",
          provider: "",
          model: "",
          cacheHit: false,
        };
      }

      const analyzer = watch.feedback.analyzer ?? watch.analyzers.feedback;
      if (!analyzer) {
        throw new Error(
          `watch '${session.watchId}' has no feedback analyzer configured (set feedback.analyzer or analyzers.feedback)`,
        );
      }

      const cap = watch.feedback.max_active_lessons_per_category;
      const categories: LessonCategory[] = ["detecting", "reviewing", "finalizing"];
      const byCategory = await Promise.all(
        categories.map((cat) =>
          loadLessonsForReplay({
            watchId: session.watchId,
            category: cat,
            cap,
            lessonsMode: session.lessonsMode,
            windowStartAt: session.windowStartAt,
            // The feedback prompt always inspects the full pool; injection
            // toggles only gate prompt-time use at stages, not the
            // feedback analyzer's own knowledge of the pool.
            injection: true,
          }).then((lessons) => ({ cat, lessons })),
        ),
      );
      const existingFlat: Array<{
        id: string;
        category: LessonCategory;
        title: string;
        body: string;
        timesReinforced: number;
      }> = [];
      const poolStats: Record<LessonCategory, number> = {
        detecting: 0,
        reviewing: 0,
        finalizing: 0,
      };
      for (const { cat, lessons } of byCategory) {
        poolStats[cat] = lessons.length;
        for (const l of lessons) {
          existingFlat.push({
            id: l.id,
            category: cat,
            title: l.title,
            body: l.body,
            // Reinforcement count is irrelevant at the proposal-only stage —
            // the LLM has no signal to grow it inside a replay session.
            timesReinforced: 0,
          });
        }
      }

      const feedbackPrompt = await loadPrompt("feedback");
      const closeOutcome = { reason: input.closeReason, everConfirmed: input.everConfirmed };
      const userPrompt = feedbackPrompt.render({
        closeOutcome,
        scoreAtClose: input.scoreAtClose,
        poolStats,
        maxActivePerCategory: cap,
        existingLessons: existingFlat,
        contextChunks: [],
      });

      const wrappedProviders = wrapLlmProvidersWithCache(
        deps.llmProviders,
        deps.cacheStore,
        feedbackPrompt.version,
      );
      const startedAt = Date.now();
      const result = await resolveAndCall(
        analyzer.provider,
        {
          systemPrompt: feedbackPrompt.systemPrompt,
          userPrompt,
          model: analyzer.model,
          responseSchema: FeedbackOutputSchema,
        },
        wrappedProviders,
      );
      const latencyMs = Date.now() - startedAt;

      const cacheHit = wasCacheHit(result.output);
      const parsed = result.output.parsed as FeedbackOutput;

      await deps.replayLlmCallStore.record({
        sessionId: input.sessionId,
        setupId: input.setupId,
        stage: "feedback",
        provider: result.usedProvider,
        model: analyzer.model,
        promptTokens: result.output.promptTokens,
        completionTokens: result.output.completionTokens,
        cacheReadTokens: result.output.cacheReadTokens ?? 0,
        cacheCreateTokens: result.output.cacheWriteTokens ?? 0,
        costUsd: result.output.costUsd,
        latencyMs,
        cacheHit,
      });
      if (!cacheHit && result.output.costUsd > 0) {
        await deps.sessionsRepo.incrementCost(input.sessionId, result.output.costUsd);
      }

      // Persist each proposed action as a `FeedbackLessonProposed` event.
      // Live also runs a validation step (cap/asset/pinned), but in replay
      // we capture EVERY proposal verbatim — the user reviews them on the
      // UI and decides what to promote.
      // Anchor `occurredAt` to the simulated close instant via FixedClock
      // (spec §2 #6 + §10 invariant 7 — reproducibility). Wall-clock
      // `new Date()` would make the timestamps drift on retry.
      const simulatedClock = new FixedClock(new Date(input.tickAt));
      for (const action of parsed.actions) {
        await deps.replayEventStore.append(input.sessionId, {
          setupId: input.setupId,
          occurredAt: simulatedClock.now(),
          stage: "feedback",
          actor: result.usedProvider,
          type: "FeedbackLessonProposed",
          scoreDelta: 0,
          payload: {
            type: "FeedbackLessonProposed",
            data: mapActionToProposedPayload(action, input.setupId),
          },
          provider: result.usedProvider,
          model: analyzer.model,
          promptVersion: feedbackPrompt.version,
          latencyMs,
          cacheHit,
        });
      }

      childLog.info(
        {
          actions: parsed.actions.length,
          costUsd: result.output.costUsd,
          cacheHit,
        },
        "runFeedbackAnalysisReplay complete",
      );

      return {
        skipped: false,
        summary: parsed.summary,
        actions: parsed.actions,
        costUsd: result.output.costUsd,
        promptVersion: feedbackPrompt.version,
        provider: result.usedProvider,
        model: analyzer.model,
        cacheHit,
      };
    },

    /**
     * Workflow plumbing: append a single event to `replay_events`. The
     * replay workflow uses this to persist setup-level domain events
     * (SetupCreated, Strengthened, Confirmed, ...) that the activities
     * themselves don't emit, since per-stage activities only persist their
     * own tick-trace event (DetectorTickProcessed, FeedbackLessonProposed).
     *
     * Returns the stored event so the workflow can echo `sequence` /
     * `id` into its in-memory state if needed.
     */
    async appendReplayEvent(input: AppendReplayEventInput): Promise<StoredReplayEvent> {
      return deps.replayEventStore.append(input.sessionId, input.event);
    },

    /**
     * Workflow plumbing: load the session row so the workflow can read its
     * config snapshot, mode flags, and window bounds in one shot rather
     * than threading them through every activity input.
     */
    async loadReplaySession(input: { sessionId: string }): Promise<LoadReplaySessionResult> {
      const session = await deps.sessionsRepo.get(input.sessionId);
      if (!session) throw new Error(`Replay session ${input.sessionId} not found`);
      return { session };
    },

    /**
     * Workflow plumbing: update the session status (READY / PAUSED /
     * COMPLETED / COST_CAPPED / FAILED). Atomic for concurrent writes.
     */
    async updateReplaySessionStatus(input: {
      sessionId: string;
      status: "READY" | "PAUSED" | "COMPLETED" | "COST_CAPPED" | "FAILED";
      failureReason?: string;
    }): Promise<void> {
      await deps.sessionsRepo.updateStatus(input.sessionId, input.status, input.failureReason);
    },

    /**
     * Workflow plumbing: fetches the candles inside `(from, to]` for the
     * session's watch. Used by `processTick` to feed the intra-candle
     * tracking simulation between two consecutive ticks. The window is
     * half-open on the left so consecutive calls don't double-process
     * the boundary candle.
     */
    async fetchRangeCandles(input: {
      sessionId: string;
      from: string;
      to: string;
    }): Promise<{ candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }> }> {
      const session = await deps.sessionsRepo.get(input.sessionId);
      if (!session) throw new Error(`Replay session ${input.sessionId} not found`);
      const watch = session.configSnapshot;
      const fetcher = deps.marketDataFetchers.get(watch.asset.source);
      if (!fetcher) throw new InvalidConfigError(`No fetcher for source ${watch.asset.source}`);
      const from = new Date(input.from);
      const to = new Date(input.to);
      const raw = await fetcher.fetchRange({
        asset: watch.asset.symbol,
        timeframe: watch.timeframes.primary,
        from,
        to,
      });
      // Half-open left, inclusive right : the candle whose timestamp ==
      // `from` was already processed by the previous tick.
      return {
        candles: raw
          .filter((c) => c.timestamp.getTime() > from.getTime())
          .map((c) => ({
            timestamp: c.timestamp.toISOString(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          })),
      };
    },
  };
}

/**
 * Maps a feedback `LessonAction` to the persisted `FeedbackLessonProposed`
 * payload shape. The action discriminant defines what gets captured for
 * later user review.
 */
function mapActionToProposedPayload(
  action: LessonAction,
  sourceTradeSetupId: string,
): {
  action: "CREATE" | "REINFORCE" | "REFINE" | "DEPRECATE";
  title: string;
  body: string;
  rationale: string;
  sourceTradeSetupId: string;
  supersedesLessonId?: string;
} {
  switch (action.type) {
    case "CREATE":
      return {
        action: "CREATE",
        title: action.title,
        body: action.body,
        rationale: action.rationale,
        sourceTradeSetupId,
      };
    case "REINFORCE":
      return {
        action: "REINFORCE",
        title: `[REINFORCE] ${action.lessonId}`,
        body: action.reason,
        rationale: action.reason,
        sourceTradeSetupId,
        supersedesLessonId: action.lessonId,
      };
    case "REFINE":
      return {
        action: "REFINE",
        title: action.newTitle,
        body: action.newBody,
        rationale: action.rationale,
        sourceTradeSetupId,
        supersedesLessonId: action.lessonId,
      };
    case "DEPRECATE":
      return {
        action: "DEPRECATE",
        title: `[DEPRECATE] ${action.lessonId}`,
        body: action.reason,
        rationale: action.reason,
        sourceTradeSetupId,
        supersedesLessonId: action.lessonId,
      };
  }
}

