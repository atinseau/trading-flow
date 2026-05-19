import {
  type AliveSetup,
  processTick,
  type ReplayActivityProxies,
} from "@workflows/replay/processTick";
import type { CapturedEvent, PipelineScenario } from "../types";

/**
 * Run a `PipelineScenario` against the replay pipeline.
 *
 * Strategy : assemble an in-memory `ReplayActivityProxies` with stubbed
 * adapters that replay the scenario tick-by-tick :
 *
 *   - `runDetectorReplay`  → returns `scenario.ticks[i].detectorVerdict`
 *   - `runReviewerReplay`  → returns `scenario.ticks[i].reviewerVerdict`
 *   - `runFinalizerReplay` → returns `scenario.ticks[i].finalizerDecision`
 *   - `fetchRangeCandles`  → returns `[scenario.ticks[i].candle]`
 *   - `appendReplayEvent`  → captures into `events: CapturedEvent[]`
 *
 * Then : invoke `processTick()` directly per tick. The replay tick
 * orchestrator is plain async TS — no Temporal sandbox required, plain
 * function composition.
 *
 * The setup declared in `scenario.setup` is seeded into the `alive` map
 * BEFORE the first tick (as if it had been created on a prior tick), so
 * the scenario's ticks exercise the corroboration / reviewer / finalizer
 * paths on an existing setup. New-setup creation is exercised by
 * scenarios where `detectorVerdict.new_setups` is non-empty (left to
 * later tasks).
 */
export async function runReplay(scenario: PipelineScenario): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = [];

  // Seed the alive Map as if the setup was created on a prior tick.
  const alive = new Map<string, AliveSetup>();
  const firstTickAtMs = Date.parse(scenario.ticks[0]?.tickAt ?? new Date().toISOString());
  alive.set(scenario.setup.setupId, {
    id: scenario.setup.setupId,
    snapshot: {
      id: scenario.setup.setupId,
      watchId: scenario.watch.id,
      asset: scenario.watch.asset.symbol,
      timeframe: scenario.watch.timeframes.primary,
      patternHint: scenario.setup.patternHint,
      patternCategory: scenario.setup.patternCategory,
      expectedMaturationTicks: scenario.setup.expectedMaturationTicks,
      direction: scenario.setup.direction,
      currentScore: scenario.setup.initialScore,
      invalidationLevel: scenario.setup.invalidationLevel,
    },
    runtime: {
      status: "REVIEWING",
      score: scenario.setup.initialScore,
      invalidationLevel: scenario.setup.invalidationLevel,
      direction: scenario.setup.direction,
    },
    // 50 candles × 1h = 50 hours of TTL (matches scenario watch config).
    ttlExpiresAt: new Date(firstTickAtMs + 50 * 3600_000),
  });

  let prevTickAt: string | null = null;

  for (let i = 0; i < scenario.ticks.length; i++) {
    const tick = scenario.ticks[i];
    if (!tick) continue;

    const proxies = makeFakeProxies(scenario, i, events);

    await processTick(
      { llm: proxies, db: proxies },
      {
        sessionId: "parity-replay-session",
        watch: scenario.watch,
        tickAt: tick.tickAt,
        alive,
        prevTickAt,
        costSoFarBefore: 0,
        costCapUsd: 1_000,
        newUuid: () => `parity-${scenario.name}-${i}`,
      },
    );
    prevTickAt = tick.tickAt;
  }

  return events;
}

/**
 * Build a fake `ReplayActivityProxies` for a given tick index. Captures
 * each `appendReplayEvent` call into the shared `events` array as a
 * `CapturedEvent`, normalizing the few fields the comparator inspects.
 */
function makeFakeProxies(
  scenario: PipelineScenario,
  tickIdx: number,
  events: CapturedEvent[],
): ReplayActivityProxies {
  const tick = scenario.ticks[tickIdx];
  if (!tick) throw new Error(`tick ${tickIdx} out of range`);

  let seq = 0;
  const proxies = {
    runDetectorReplay: async () => ({
      verdictJson: JSON.stringify(tick.detectorVerdict),
      chartUri: "mem://chart",
      ohlcvUri: "mem://ohlcv",
      indicatorsJson: "{}",
      lastClose: tick.candle.close,
      costUsd: 0,
      promptVersion: "detector_v7",
      cacheHit: false,
    }),
    runReviewerReplay: async () => ({
      verdictJson: JSON.stringify(tick.reviewerVerdict ?? { type: "NEUTRAL", observations: [] }),
      costUsd: 0,
      promptVersion: "reviewer_v6",
      provider: "fake",
      model: "fake-model",
      cacheHit: false,
    }),
    runFinalizerReplay: async () => ({
      decisionJson: JSON.stringify(
        tick.finalizerDecision ?? { go: false, reasoning: "no-decision-in-scenario" },
      ),
      costUsd: 0,
      promptVersion: "finalizer_v4",
      provider: "fake",
      model: "fake-model",
      cacheHit: false,
    }),
    runFeedbackAnalysisReplay: async () => ({
      skipped: true,
      summary: "",
      actions: [],
      costUsd: 0,
      promptVersion: "feedback_v1",
      provider: "fake",
      model: "fake-model",
      cacheHit: false,
    }),
    appendReplayEvent: async (input: {
      sessionId: string;
      event: {
        setupId: string | null;
        occurredAt: Date;
        stage: string;
        actor: string;
        type: string;
        scoreDelta: number;
        scoreAfter?: number | null;
        statusBefore?: string | null;
        statusAfter?: string | null;
        payload: { type: string; data?: Record<string, unknown> };
      };
    }) => {
      seq += 1;
      const ev = input.event;
      if (ev.setupId !== null) {
        const payloadData = (ev.payload?.data ?? {}) as { source?: string };
        events.push({
          setupId: ev.setupId,
          type: ev.type,
          stage: ev.stage,
          actor: ev.actor,
          scoreDelta: ev.scoreDelta,
          scoreAfter: ev.scoreAfter ?? 0,
          statusBefore: (ev.statusBefore ?? null) as CapturedEvent["statusBefore"],
          statusAfter: (ev.statusAfter ?? null) as CapturedEvent["statusAfter"],
          payloadType: ev.payload?.type ?? ev.type,
          payloadSource: payloadData.source,
          occurredAt: ev.occurredAt.toISOString(),
        });
      }
      return {
        ...ev,
        id: `parity-evt-${tickIdx}-${seq}`,
        sessionId: input.sessionId,
        sequence: seq,
      } as never;
    },
    loadReplaySession: async () => ({}) as never,
    updateReplaySessionStatus: async () => undefined,
    fetchRangeCandles: async () => {
      // Single-candle window — replay's intra-candle tracker + price-breach
      // pass use this same proxy for both the "current tick" candle and the
      // gap between prevTickAt → tickAt. Returning just `tick.candle` matches
      // the live runner's behavior (signals one trackingPrice per
      // intra-candle price).
      return {
        candles: [
          {
            timestamp: tick.candle.timestamp,
            open: tick.candle.open,
            high: tick.candle.high,
            low: tick.candle.low,
            close: tick.candle.close,
            volume: 100,
          },
        ],
      };
    },
  };
  return proxies as unknown as ReplayActivityProxies;
}
