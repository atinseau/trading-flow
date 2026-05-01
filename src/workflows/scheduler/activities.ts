import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { watchStates } from "@adapters/persistence/schema";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { InvalidConfigError } from "@domain/errors";
import { CandleSchema } from "@domain/schemas/Candle";
import { computeHtfContext } from "@domain/services/htfContext";
import { inferImageMimeType } from "@domain/services/imageMimeType";
import { getLogger } from "@observability/logger";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { z } from "zod";
import { dedupNewSetups, type ProposedSetup } from "./dedup";
import { evaluatePreFilter } from "./preFilter";

const log = getLogger({ component: "scheduler-activities" });

const DetectorVerdictSchema = z.object({
  corroborations: z.array(
    z.object({
      setup_id: z.string(),
      evidence: z.array(z.string()),
      confidence_delta_suggested: z.number(),
    }),
  ),
  new_setups: z.array(
    z
      .object({
        type: z.string(),
        direction: z.enum(["LONG", "SHORT"]),
        // Pattern classification — analytic label for the feedback loop.
        pattern_category: z.enum(["event", "accumulation"]),
        // Operational maturation estimate (drives finalizer rule).
        expected_maturation_ticks: z.number().int().min(1).max(6),
        // Auditable score breakdown — initial_score must approximately equal
        // the sum (refine below). Forces the LLM to expose its reasoning.
        confidence_breakdown: z.object({
          trigger: z.number().min(0).max(25),
          structure: z.number().min(0).max(25),
          htf: z.number().min(0).max(25),
          volume: z.number().min(0).max(25),
        }),
        key_levels: z.object({
          entry: z.number().optional(),
          invalidation: z.number(),
          target: z.number().optional(),
        }),
        initial_score: z.number().min(0).max(100),
        raw_observation: z.string(),
      })
      .refine(
        (s) => {
          // Enforce: |initial_score - sum(breakdown)| ≤ 2. Without this,
          // the same-tick fast-path can fire on a hallucinated score with no
          // backing breakdown, bypassing the only structural sanity check we
          // have on detector output.
          const sum =
            s.confidence_breakdown.trigger +
            s.confidence_breakdown.structure +
            s.confidence_breakdown.htf +
            s.confidence_breakdown.volume;
          return Math.abs(s.initial_score - sum) <= 2;
        },
        { message: "initial_score must equal sum(confidence_breakdown) ±2" },
      )
      .refine(
        (s) => {
          // Sanity: event ⇒ matures fast; accumulation ⇒ matures slow.
          // Without this, an LLM could declare event + maturation=5 (nonsense)
          // and the finalizer's per-setup maturation rule loses its meaning.
          if (s.pattern_category === "event") return s.expected_maturation_ticks <= 2;
          return s.expected_maturation_ticks >= 3;
        },
        { message: "event ⇒ ticks ≤ 2; accumulation ⇒ ticks ≥ 3" },
      ),
  ),
  ignore_reason: z.string().nullable(),
});

function dateReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return value;
}

export function buildSchedulerActivities(deps: ActivityDeps) {
  return {
    async fetchOHLCV(input: { watchId: string }): Promise<{ ohlcvJson: string }> {
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      const fetcher = deps.marketDataFetchers.get(watch.asset.source);
      if (!fetcher) throw new InvalidConfigError(`No fetcher for source ${watch.asset.source}`);
      const candles = await fetcher.fetchOHLCV({
        asset: watch.asset.symbol,
        timeframe: watch.timeframes.primary,
        limit: watch.candles.detector_lookback,
      });
      return { ohlcvJson: JSON.stringify(candles) };
    },

    async renderChart(input: {
      ohlcvJson: string;
      watchId: string;
    }): Promise<{ artifactUri: string; sha256: string }> {
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      const candles = z.array(CandleSchema).parse(JSON.parse(input.ohlcvJson, dateReviver));
      // Compute series on the FULL window (≥200 candles, needed for EMA200
      // warm-up) then slice both candles AND series to the chart window so
      // the EMA200 line is non-null on the visible portion.
      const fullSeries = await deps.indicatorCalculator.computeSeries(candles);
      const w = watch.candles.reviewer_chart_window;
      const slice = candles.slice(-w);
      const sliceLine = (arr: (number | null)[]) => arr.slice(-w);
      const total = candles.length;
      const offset = total - slice.length;
      const sliceMarkers = <T extends { index: number }>(arr: T[]) =>
        arr.filter((m) => m.index >= offset).map((m) => ({ ...m, index: m.index - offset }));
      const series = {
        ema20: sliceLine(fullSeries.ema20),
        ema50: sliceLine(fullSeries.ema50),
        ema200: sliceLine(fullSeries.ema200),
        vwap: sliceLine(fullSeries.vwap),
        bbUpper: sliceLine(fullSeries.bbUpper),
        bbMiddle: sliceLine(fullSeries.bbMiddle),
        bbLower: sliceLine(fullSeries.bbLower),
        rsi: sliceLine(fullSeries.rsi),
        atr: sliceLine(fullSeries.atr),
        atrMa20: sliceLine(fullSeries.atrMa20),
        volumeMa20: sliceLine(fullSeries.volumeMa20),
        macd: sliceLine(fullSeries.macd),
        macdSignal: sliceLine(fullSeries.macdSignal),
        macdHist: sliceLine(fullSeries.macdHist),
        swingHighs: sliceMarkers(fullSeries.swingHighs),
        swingLows: sliceMarkers(fullSeries.swingLows),
        fvgs: sliceMarkers(fullSeries.fvgs),
        equalHighs: fullSeries.equalHighs
          .map((g) => ({
            price: g.price,
            indices: g.indices.filter((i) => i >= offset).map((i) => i - offset),
          }))
          .filter((g) => g.indices.length >= 2),
        equalLows: fullSeries.equalLows
          .map((g) => ({
            price: g.price,
            indices: g.indices.filter((i) => i >= offset).map((i) => i - offset),
          }))
          .filter((g) => g.indices.length >= 2),
      };
      const tempUri = `file:///tmp/temp-chart-${crypto.randomUUID()}.png`;
      const result = await deps.chartRenderer.render({
        candles: slice,
        indicators: series,
        width: 1600,
        height: 1000,
        outputUri: tempUri,
      });
      const stored = await deps.artifactStore.put({
        kind: "chart_image",
        content: result.content,
        mimeType: result.mimeType,
      });
      return { artifactUri: stored.uri, sha256: stored.sha256 };
    },

    async computeIndicators(input: { ohlcvJson: string }): Promise<{ indicatorsJson: string }> {
      const candles = z.array(CandleSchema).parse(JSON.parse(input.ohlcvJson, dateReviver));
      const ind = await deps.indicatorCalculator.compute(candles);
      return { indicatorsJson: JSON.stringify(ind) };
    },

    async evaluatePreFilter(input: {
      ohlcvJson: string;
      indicatorsJson: string;
      watchId: string;
    }): Promise<{ passed: boolean; reasons: string[] }> {
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      const candles = z.array(CandleSchema).parse(JSON.parse(input.ohlcvJson, dateReviver));
      const ind = JSON.parse(input.indicatorsJson);
      return evaluatePreFilter(candles, ind, watch.pre_filter);
    },

    async createTickSnapshot(input: {
      watchId: string;
      chartUri: string;
      ohlcvUri: string;
      ohlcvJson: string;
      indicatorsJson: string;
      preFilterPass: boolean;
    }): Promise<{ tickSnapshotId: string }> {
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      // Extract live price from the candle just used to compute indicators —
      // this is the source of truth for "current price" downstream.
      const candles = z.array(CandleSchema).parse(JSON.parse(input.ohlcvJson, dateReviver));
      const lastClose = candles[candles.length - 1]?.close ?? null;
      const snap = await deps.tickSnapshotStore.create({
        watchId: input.watchId,
        tickAt: deps.clock.now(),
        asset: watch.asset.symbol,
        timeframe: watch.timeframes.primary,
        ohlcvUri: input.ohlcvUri,
        chartUri: input.chartUri,
        indicators: JSON.parse(input.indicatorsJson),
        lastClose,
        preFilterPass: input.preFilterPass,
      });
      return { tickSnapshotId: snap.id };
    },

    async listAliveSetups(input: { watchId: string }) {
      return deps.setupRepo.listAlive(input.watchId);
    },

    async runDetector(input: {
      watchId: string;
      tickSnapshotId: string;
      aliveSetups: unknown;
    }): Promise<{ verdictJson: string; costUsd: number; promptVersion: string }> {
      const childLog = log.child({
        watchId: input.watchId,
        tickSnapshotId: input.tickSnapshotId,
      });
      childLog.info(
        {
          aliveSetupCount: Array.isArray(input.aliveSetups) ? input.aliveSetups.length : 0,
        },
        "runDetector starting",
      );
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      const snap = await deps.tickSnapshotStore.get(input.tickSnapshotId);
      if (!snap) throw new Error(`TickSnapshot ${input.tickSnapshotId} not found`);

      const activeLessons = watch.feedback.injection.detector
        ? await deps.lessonStore.listActive({
            watchId: input.watchId,
            category: "detecting",
            limit: watch.feedback.max_active_lessons_per_category,
          })
        : [];
      if (activeLessons.length > 0) {
        await deps.lessonStore.incrementUsage(activeLessons.map((l) => l.id));
      }

      // HTF context: fetch a daily window for the same asset to give the
      // detector structural awareness (weekly H/L, daily trend regime,
      // position in weekly range). Adds ~1 cheap API call per tick.
      const fetcher = deps.marketDataFetchers.get(watch.asset.source);
      const livePrice = snap.indicators.recentHigh; // best proxy from snapshot
      const htf = fetcher
        ? await computeHtfContext({
            marketDataFetcher: fetcher,
            asset: watch.asset.symbol,
            livePrice,
          })
        : null;

      const detectorPrompt = await loadPrompt("detector");
      const userPrompt = detectorPrompt.render({
        asset: snap.asset,
        timeframe: snap.timeframe,
        tickAt: snap.tickAt.toISOString(),
        indicators: snap.indicators,
        htf,
        aliveSetups: input.aliveSetups,
        activeLessons: activeLessons.map((l) => ({ title: l.title, body: l.body })),
      });
      const result = await resolveAndCall(
        watch.analyzers.detector.provider,
        {
          systemPrompt: detectorPrompt.systemPrompt,
          userPrompt,
          images: [{ sourceUri: snap.chartUri, mimeType: inferImageMimeType(snap.chartUri) }],
          model: watch.analyzers.detector.model,
          maxTokens: watch.analyzers.detector.max_tokens,
          responseSchema: DetectorVerdictSchema,
        },
        deps.llmProviders,
      );
      await deps.llmCallStore.record({
        watchId: input.watchId,
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
      });
      childLog.info(
        {
          costUsd: result.output.costUsd,
          provider: result.usedProvider,
          model: watch.analyzers.detector.model,
        },
        "runDetector complete",
      );
      return {
        verdictJson: JSON.stringify(result.output.parsed),
        costUsd: result.output.costUsd,
        promptVersion: detectorPrompt.version,
      };
    },

    async dedupNewSetups(input: {
      newSetupsJson: string;
      aliveSetupsJson: string;
      watchId: string;
    }) {
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      // The detector prompt returns snake_case (`key_levels`, `initial_score`,
      // `raw_observation`) per the LLM-facing schema; ProposedSetup is
      // camelCase. Normalize at the boundary so downstream workflow code can
      // rely on a single shape.
      type SnakeProposed = {
        type: string;
        direction: "LONG" | "SHORT";
        pattern_category: "event" | "accumulation";
        expected_maturation_ticks: number;
        key_levels: { invalidation: number; entry?: number; target?: number };
        initial_score: number;
        raw_observation: string;
      };
      const raw = JSON.parse(input.newSetupsJson) as SnakeProposed[];
      const newSetups: ProposedSetup[] = raw.map((s) => ({
        type: s.type,
        direction: s.direction,
        category: s.pattern_category,
        expectedMaturationTicks: s.expected_maturation_ticks,
        keyLevels: s.key_levels,
        initialScore: s.initial_score,
        rawObservation: s.raw_observation,
      }));
      const alive = JSON.parse(input.aliveSetupsJson);
      return dedupNewSetups(newSetups, alive, {
        similarSetupWindowCandles: watch.deduplication.similar_setup_window_candles,
        similarPriceTolerancePct: watch.deduplication.similar_price_tolerance_pct,
      });
    },

    async recordWatchTick(input: {
      watchId: string;
      status: string;
      costUsd: number;
    }): Promise<void> {
      const childLog = log.child({ watchId: input.watchId });
      childLog.info({ status: input.status, costUsd: input.costUsd }, "tick recorded");
      const now = deps.clock.now();
      // Cost is no longer cached on watch_states — `llm_calls` is the source of
      // truth, aggregated on read by the API. We still touch the row to keep
      // lastTickAt / lastTickStatus fresh for the "dernier tick il y a X" UI.
      await deps.db
        .insert(watchStates)
        .values({
          watchId: input.watchId,
          lastTickAt: now,
          lastTickStatus: input.status,
        })
        .onConflictDoUpdate({
          target: watchStates.watchId,
          set: {
            lastTickAt: now,
            lastTickStatus: input.status,
          },
        });
    },

    async loadWatchConfig(input: { watchId: string }) {
      return deps.watchById(input.watchId);
    },

    async persistOHLCVArtifact(input: {
      ohlcvJson: string;
    }): Promise<{ artifactUri: string; sha256: string }> {
      const stored = await deps.artifactStore.put({
        kind: "ohlcv_snapshot",
        content: Buffer.from(input.ohlcvJson, "utf8"),
        mimeType: "application/json",
      });
      return { artifactUri: stored.uri, sha256: stored.sha256 };
    },

    async reloadConfigFromDb(_input: Record<string, never>): Promise<{ reloaded: boolean }> {
      const watches = await loadWatchesFromDb(deps.pgPool);
      // Mutate the captured config object in place so the watchById closure
      // and any other references see the new data without rebuilding deps.
      deps.config.watches.length = 0;
      for (const w of watches) deps.config.watches.push(w);
      return { reloaded: true };
    },
  };
}
