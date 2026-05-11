import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import { InvalidConfigError } from "@domain/errors";
import type { EventPayload } from "@domain/events/schemas";
import { filterLessonsForReplay, type LessonLike } from "@domain/replay/lessonsLookup";
import type { Candle } from "@domain/schemas/Candle";
import { buildDetectorOutputSchema } from "@domain/schemas/DetectorOutput";
import { buildIndicatorsSchema } from "@domain/schemas/Indicators";
import {
  ReviewerLlmOutputSchema,
  type ReviewerLlmOutput,
} from "@domain/schemas/ReviewerOutput";
import { VerdictSchema, type Verdict } from "@domain/schemas/Verdict";
import { summarizeHtf } from "@domain/services/htfContext";
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

  /**
   * Fetches a historical HTF (daily) candle slice ending at `tickAt`. Used
   * by reviewer and finalizer when computing HTF context in replay mode.
   * Live `computeHtfContext` doesn't accept an endTime — duplicating the
   * thin fetch + summarize chain here is the cheapest way to keep replay
   * deterministic without touching the live signature.
   */
  async function fetchHtfContextAt(args: {
    source: string;
    asset: string;
    livePrice: number;
    endTime: Date;
  }) {
    const fetcher = deps.marketDataFetchers.get(args.source);
    if (!fetcher) return null;
    const dailies = await fetcher.fetchOHLCV({
      asset: args.asset,
      timeframe: "1d",
      limit: 30,
      endTime: args.endTime,
    });
    return summarizeHtf(dailies as Candle[], args.livePrice);
  }

  /**
   * Renders a HTF chart from a `tickAt`-anchored daily slice. Mirrors
   * `renderHtfChart` but threads the `endTime` so we don't leak future
   * candles into the replay.
   */
  async function renderHtfChartAt(args: {
    source: string;
    asset: string;
    endTime: Date;
  }): Promise<string | null> {
    const fetcher = deps.marketDataFetchers.get(args.source);
    if (!fetcher) return null;
    const dailies = await fetcher.fetchOHLCV({
      asset: args.asset,
      timeframe: "1d",
      limit: 200,
      endTime: args.endTime,
    });
    if (dailies.length === 0) return null;
    const slice = dailies.slice(-60);
    const tempUri = `file:///tmp/replay-htf-${crypto.randomUUID()}.png`;
    const plugins = deps.indicatorRegistry.resolveActive({});
    const paramsByPlugin: Record<string, Record<string, unknown>> = {};
    for (const p of plugins) {
      paramsByPlugin[p.id] = (p.defaultParams as Record<string, unknown>) ?? {};
    }
    const series =
      plugins.length > 0 && dailies.length >= 60
        ? await deps.indicatorCalculator.computeSeries(slice, plugins, paramsByPlugin)
        : {};
    const enabledIds = plugins.length > 0 && dailies.length >= 60 ? plugins.map((p) => p.id) : [];
    const result = await deps.chartRenderer.render({
      candles: slice,
      series,
      enabledIndicatorIds: enabledIds,
      width: 1280,
      height: 900,
      outputUri: tempUri,
    });
    const stored = await deps.artifactStore.put({
      kind: "chart_image",
      content: result.content,
      mimeType: result.mimeType,
    });
    return stored.uri;
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
      const height =
        naked ? 900 : secondaryPaneCount >= 3 ? 1080 : secondaryPaneCount >= 1 ? 720 : 900;
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

      const parsed = (result.output.parsed ?? null) as
        | { ignore_reason?: string | null; new_setups?: unknown[] }
        | null;
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
      const htf = await fetchHtfContextAt({
        source: watch.asset.source,
        asset: watch.asset.symbol,
        livePrice: input.lastClose,
        endTime: tickAt,
      });

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
    async runFinalizerReplay(
      input: RunFinalizerReplayInput,
    ): Promise<RunFinalizerReplayResult> {
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

      const htf = await fetchHtfContextAt({
        source: watch.asset.source,
        asset: watch.asset.symbol,
        livePrice: input.latestLastClose,
        endTime: tickAt,
      });
      const htfChartUri = await renderHtfChartAt({
        source: watch.asset.source,
        asset: watch.asset.symbol,
        endTime: tickAt,
      });

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
  };
}

function extractObservations(payload: EventPayload): unknown[] {
  if (
    payload.type === "Strengthened" ||
    payload.type === "Weakened" ||
    payload.type === "Neutral"
  ) {
    return payload.data.observations;
  }
  return [];
}

function extractReasoning(payload: EventPayload): string | null {
  if (payload.type === "Strengthened" || payload.type === "Weakened") {
    return payload.data.reasoning;
  }
  return null;
}
