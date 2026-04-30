import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { REGISTRY } from "@adapters/indicators/IndicatorRegistry";
import { watchStates } from "@adapters/persistence/schema";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { InvalidConfigError } from "@domain/errors";
import { CandleSchema } from "@domain/schemas/Candle";
import { getLogger } from "@observability/logger";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { sql } from "drizzle-orm";
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
    z.object({
      type: z.string(),
      direction: z.enum(["LONG", "SHORT"]),
      key_levels: z.object({
        entry: z.number().optional(),
        invalidation: z.number(),
        target: z.number().optional(),
      }),
      initial_score: z.number().min(0).max(100),
      raw_observation: z.string(),
    }),
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
      const slice = candles.slice(-watch.candles.reviewer_chart_window);
      const tempUri = `file:///tmp/temp-chart-${crypto.randomUUID()}.png`;
      const result = await deps.chartRenderer.render({
        candles: slice,
        width: 1280,
        height: 720,
        outputUri: tempUri,
      });
      const stored = await deps.artifactStore.put({
        kind: "chart_image",
        content: result.content,
        mimeType: "image/png",
      });
      return { artifactUri: stored.uri, sha256: stored.sha256 };
    },

    async computeIndicators(input: { ohlcvJson: string }): Promise<{ indicatorsJson: string }> {
      const candles = z.array(CandleSchema).parse(JSON.parse(input.ohlcvJson, dateReviver));
      // TODO(Task 30): resolve active plugins from watch config instead of using full REGISTRY.
      const ind = await deps.indicatorCalculator.compute(candles, REGISTRY);
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
      indicatorsJson: string;
      preFilterPass: boolean;
    }): Promise<{ tickSnapshotId: string }> {
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      const snap = await deps.tickSnapshotStore.create({
        watchId: input.watchId,
        tickAt: deps.clock.now(),
        asset: watch.asset.symbol,
        timeframe: watch.timeframes.primary,
        ohlcvUri: input.ohlcvUri,
        chartUri: input.chartUri,
        indicators: JSON.parse(input.indicatorsJson),
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

      const detectorPrompt = await loadPrompt("detector");
      const userPrompt = detectorPrompt.render({
        asset: snap.asset,
        timeframe: snap.timeframe,
        tickAt: snap.tickAt.toISOString(),
        indicators: snap.indicators,
        aliveSetups: input.aliveSetups,
        activeLessons: activeLessons.map((l) => ({ title: l.title, body: l.body })),
      });
      const result = await resolveAndCall(
        watch.analyzers.detector.provider,
        {
          systemPrompt: detectorPrompt.systemPrompt,
          userPrompt,
          images: [{ sourceUri: snap.chartUri, mimeType: "image/png" }],
          model: watch.analyzers.detector.model,
          maxTokens: watch.analyzers.detector.max_tokens,
          responseSchema: DetectorVerdictSchema,
        },
        deps.llmProviders,
      );
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
      const newSetups = JSON.parse(input.newSetupsJson) as ProposedSetup[];
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
      const costStr = String(input.costUsd);
      await deps.db
        .insert(watchStates)
        .values({
          watchId: input.watchId,
          lastTickAt: now,
          lastTickStatus: input.status,
          totalCostUsdMtd: costStr,
          totalCostUsdAllTime: costStr,
        })
        .onConflictDoUpdate({
          target: watchStates.watchId,
          set: {
            lastTickAt: now,
            lastTickStatus: input.status,
            totalCostUsdMtd: sql`${watchStates.totalCostUsdMtd} + ${costStr}`,
            totalCostUsdAllTime: sql`${watchStates.totalCostUsdAllTime} + ${costStr}`,
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
