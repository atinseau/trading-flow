import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { InvalidConfigError } from "@domain/errors";
import { filterLessonsForReplay, type LessonLike } from "@domain/replay/lessonsLookup";
import { buildDetectorOutputSchema } from "@domain/schemas/DetectorOutput";
import { buildIndicatorsSchema } from "@domain/schemas/Indicators";
import { getLogger } from "@observability/logger";
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

export type ReplayActivities = ReturnType<typeof buildReplayActivities>;

export function buildReplayActivities(deps: ReplayActivityDeps) {
  return {
    /**
     * Replay-mode detector tick.
     *
     * Mirrors the live `fetchOHLCV → computeIndicators → renderChart →
     * runDetector` chain in a single deterministic call, parameterized by
     * the session's `tickAt`. Differences vs. live :
     *
     *  - OHLCV is fetched with `endTime = tickAt` (historical slice).
     *  - The chart artifact and OHLCV artifact are stored in the shared
     *    `artifactStore`. The store is content-addressable, so identical
     *    inputs across sessions hit the same artifact rows for free.
     *  - Lessons are filtered through `filterLessonsForReplay` with the
     *    session's `lessonsMode` ; we DO NOT mutate `lesson_usage_stats`.
     *  - LLM providers are wrapped in `CachedLLMProvider` before the call,
     *    keyed by the detector prompt version. Cache hits cost $0.
     *  - The LLM call is recorded into `replay_llm_calls` (scoped by
     *    `sessionId`), not the live `llm_calls`.
     *  - A `DetectorTickProcessed` event is appended to `replay_events`,
     *    regardless of whether new setups were detected — gives the UI a
     *    continuous trace of the bot's reasoning across the playhead.
     *  - Session cost is incremented atomically on a miss only.
     *
     * The activity does NOT decide whether to spawn child workflows for new
     * setups — it returns the raw verdict ; the orchestrating workflow
     * deduplicates and creates setups itself.
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

      // Chart slice + render
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

      // Lesson filtering — read live store, filter by mode + window start
      let activeLessons: ReadonlyArray<{ id: string; title: string; body: string }> = [];
      if (watch.feedback.injection.detector && session.lessonsMode !== "disabled") {
        const raw = await deps.lessonStore.listByStatus({
          watchId: session.watchId,
          category: "detecting",
        });
        const compat: LessonLike[] = raw.map((l) => ({
          id: l.id,
          watchId: l.watchId,
          status: l.status,
          activatedAt: l.activatedAt,
          deprecatedAt: l.deprecatedAt,
        }));
        const filtered = filterLessonsForReplay(
          compat,
          session.lessonsMode,
          session.windowStartAt,
        );
        const cap = watch.feedback.max_active_lessons_per_category;
        const byId = new Map(raw.map((l) => [l.id, l]));
        activeLessons = filtered
          .slice(0, cap)
          .map((l) => byId.get(l.id))
          .filter((l): l is NonNullable<typeof l> => l !== undefined)
          .map((l) => ({ id: l.id, title: l.title, body: l.body }));
        // NOTE: deliberately NOT calling `lessonStore.incrementUsage` —
        // replay must leave live lesson usage stats untouched.
      }

      // Build prompt and call LLM (wrapped with cache)
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
  };
}

