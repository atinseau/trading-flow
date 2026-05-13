import type { EventPayload } from "@domain/events/schemas";
import {
  formatConfirmedPreview,
  formatExpiredPreview,
  formatInvalidatedAfterConfirmedPreview,
  formatRejectedPreview,
  formatReviewerVerdictPreview,
  formatSLHitPreview,
  formatSetupCreatedPreview,
  formatTPHitPreview,
} from "@domain/notify/formatTelegramText";
import {
  closeReasonFromState,
  initialTrackingState,
  simulateCandleTracking,
  type TrackerEvent,
  type TrackingState,
} from "@domain/replay/simulateTracking";
import type { Verdict } from "@domain/schemas/Verdict";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { applyVerdict, type SetupRuntimeState } from "@domain/scoring/applyVerdict";
import { verdictToEvent } from "@domain/scoring/verdictToEvent";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import { isTerminal } from "@domain/state-machine/setupTransitions";
import type { ReplaySetupSnapshot } from "./activities";
import type { buildReplayActivities } from "./activities";

/**
 * Pure orchestration for a single replay tick. Extracted from the
 * Temporal workflow body so it can be unit-tested against fake
 * activities without requiring `@temporalio/testing` (the latter
 * downloads a Temporal CLI binary at first run — blocked in sandbox
 * CI, slow locally).
 *
 * The function does NOT touch Temporal primitives (no `proxyActivities`,
 * no `setHandler`, no `condition`). It accepts the activities map as
 * a plain dependency ; the workflow body wires the real `proxyActivities`
 * proxies, the test wires fakes.
 *
 * Mutates the `alive` map in place (same semantics as the previous
 * inline body). Returns the cumulative cost incurred by this tick.
 */
export type ReplayActivityProxies = ReturnType<typeof buildReplayActivities>;

export type ProcessTickDeps = {
  /** Activity proxy used for LLM calls (longer Temporal timeout). */
  llm: ReplayActivityProxies;
  /** Activity proxy used for DB / fast persistence (shorter timeout). */
  db: ReplayActivityProxies;
};

export type AliveSetup = {
  id: string;
  snapshot: ReplaySetupSnapshot;
  runtime: SetupRuntimeState;
  /** Wall-clock deadline at which this setup expires (TTL × timeframe). */
  ttlExpiresAt: Date;
  /** Trade tracker state — set when the setup is confirmed (TRACKING). */
  tracking?: TrackingState;
  /** Captured when Confirmed fires so feedback knows the score at close. */
  scoreAtConfirmation?: number;
};

export type ProcessTickArgs = {
  sessionId: string;
  watch: WatchConfig;
  tickAt: string;
  alive: Map<string, AliveSetup>;
  prevTickAt: string | null;
  costSoFarBefore: number;
  costCapUsd: number;
  /** UUID factory — Temporal workflows use `uuid4` from `@temporalio/workflow`
   *  for determinism ; tests can pass `crypto.randomUUID` or a counter stub. */
  newUuid: () => string;
};

export type ProcessTickResult = {
  /** Cumulative cost incurred by this tick (detector + reviewer + finalizer
   *  + feedback if any). */
  costUsd: number;
};

/**
 * Preventive cost-cap guard. Returns `true` once the cumulative cost
 * (across all prior ticks + this in-flight tick) has reached the cap.
 * Checked between phases so we stop BEFORE firing the next LLM call.
 */
export function isOverCap(costBefore: number, tickCost: number, capUsd: number): boolean {
  return costBefore + tickCost >= capUsd;
}

/**
 * Timeframe → minutes lookup. Inlined here so the workflow bundle stays
 * free of the schema tree.
 */
export function timeframeMinutes(tf: string): number {
  switch (tf) {
    case "1m":
      return 1;
    case "5m":
      return 5;
    case "15m":
      return 15;
    case "30m":
      return 30;
    case "1h":
      return 60;
    case "2h":
      return 120;
    case "4h":
      return 240;
    case "1d":
      return 1440;
    case "1w":
      return 10080;
    default:
      return 60;
  }
}

export async function processTick(
  deps: ProcessTickDeps,
  args: ProcessTickArgs,
): Promise<ProcessTickResult> {
  const { llm, db } = deps;
  const { sessionId, watch, tickAt, alive, prevTickAt, costSoFarBefore, costCapUsd, newUuid } =
    args;
  let tickCost = 0;
  const tickAtDate = new Date(tickAt);
  const overCap = () => isOverCap(costSoFarBefore, tickCost, costCapUsd);

  // -------- 0. TTL expiry check (before any LLM call) --------
  for (const setup of [...alive.values()]) {
    if (isTerminal(setup.runtime.status)) {
      alive.delete(setup.id);
      continue;
    }
    if (tickAtDate >= setup.ttlExpiresAt) {
      const before = { ...setup.runtime };
      setup.runtime = { ...setup.runtime, status: "EXPIRED" };
      const preview = formatExpiredPreview({
        asset: setup.snapshot.asset,
        timeframe: setup.snapshot.timeframe,
      });
      await db.appendReplayEvent({
        sessionId,
        event: {
          setupId: setup.id,
          occurredAt: tickAtDate,
          stage: "system",
          actor: "replay-workflow",
          type: "Expired",
          scoreDelta: 0,
          scoreAfter: setup.runtime.score,
          statusBefore: before.status,
          statusAfter: "EXPIRED",
          payload: {
            type: "Expired",
            data: {
              reason: "ttl_reached",
              ttlExpiresAt: setup.ttlExpiresAt.toISOString(),
              telegramPreview: preview,
            },
          },
        },
      });
      alive.delete(setup.id);
    }
  }

  // Snapshot of alive setups passed to the detector for cross-reference.
  const aliveSnapshot = [...alive.values()].map((s) => ({
    id: s.id,
    direction: s.runtime.direction,
    patternHint: s.snapshot.patternHint,
    status: s.runtime.status,
    currentScore: s.runtime.score,
    invalidationLevel: s.runtime.invalidationLevel,
  }));

  // 1) Detector tick.
  const det = await llm.runDetectorReplay({
    sessionId,
    tickAt,
    aliveSetups: aliveSnapshot,
  });
  tickCost += det.costUsd;
  if (overCap()) return { costUsd: tickCost };

  const detVerdict = JSON.parse(det.verdictJson || "{}") as {
    new_setups?: Array<{
      type: string;
      direction: "LONG" | "SHORT";
      pattern_category: "event" | "accumulation";
      expected_maturation_ticks?: number;
      key_levels: { invalidation: number };
      initial_score: number;
      raw_observation?: string;
    }>;
  };
  const newSetups = detVerdict.new_setups ?? [];

  // 2) Persist SetupCreated for each new setup.
  for (const ns of newSetups) {
    const setupId = newUuid();
    const setupCreatedPreview = formatSetupCreatedPreview({
      watchId: watch.id,
      asset: watch.asset.symbol,
      timeframe: watch.timeframes.primary,
      patternHint: ns.type,
      direction: ns.direction,
      initialScore: ns.initial_score,
      invalidationLevel: ns.key_levels.invalidation,
      rawObservation: ns.raw_observation ?? "",
    });
    await db.appendReplayEvent({
      sessionId,
      event: {
        setupId,
        occurredAt: new Date(tickAt),
        stage: "system",
        actor: "replay-workflow",
        type: "SetupCreated",
        scoreDelta: ns.initial_score,
        scoreAfter: ns.initial_score,
        statusBefore: null,
        statusAfter: "REVIEWING",
        payload: {
          type: "SetupCreated",
          data: {
            pattern: ns.type,
            direction: ns.direction,
            keyLevels: { invalidation: ns.key_levels.invalidation },
            initialScore: ns.initial_score,
            rawObservation: ns.raw_observation ?? "",
            telegramPreview: setupCreatedPreview,
          },
        },
      },
    });
    const snap: ReplaySetupSnapshot = {
      id: setupId,
      watchId: watch.id,
      asset: watch.asset.symbol,
      timeframe: watch.timeframes.primary,
      patternHint: ns.type,
      patternCategory: ns.pattern_category,
      expectedMaturationTicks: ns.expected_maturation_ticks ?? null,
      direction: ns.direction,
      currentScore: ns.initial_score,
      invalidationLevel: ns.key_levels.invalidation,
    };
    const tfMs = timeframeMinutes(watch.timeframes.primary) * 60_000;
    const ttlExpiresAt = new Date(
      tickAtDate.getTime() + watch.setup_lifecycle.ttl_candles * tfMs,
    );
    alive.set(setupId, {
      id: setupId,
      snapshot: snap,
      runtime: {
        status: "REVIEWING",
        score: ns.initial_score,
        invalidationLevel: ns.key_levels.invalidation,
        direction: ns.direction,
      },
      ttlExpiresAt,
    });
  }

  // 3) Reviewer for each REVIEWING setup.
  for (const setup of [...alive.values()]) {
    if (setup.runtime.status !== "REVIEWING") continue;
    if (overCap()) return { costUsd: tickCost };
    const r = await llm.runReviewerReplay({
      sessionId,
      tickAt,
      setup: {
        ...setup.snapshot,
        currentScore: setup.runtime.score,
        invalidationLevel: setup.runtime.invalidationLevel,
      },
      chartUri: det.chartUri,
      indicatorsJson: det.indicatorsJson,
      lastClose: det.lastClose,
    });
    tickCost += r.costUsd;
    const verdict = JSON.parse(r.verdictJson) as Verdict;
    const before = { ...setup.runtime };
    const next = applyVerdict(before, verdict, {
      scoreMax: watch.setup_lifecycle.score_max,
      scoreThresholdFinalizer: watch.setup_lifecycle.score_threshold_finalizer,
      scoreThresholdDead: watch.setup_lifecycle.score_threshold_dead,
    });
    setup.runtime = next;
    setup.snapshot = {
      ...setup.snapshot,
      currentScore: next.score,
      invalidationLevel: next.invalidationLevel,
    };

    const { type, payload } = verdictToEvent(verdict);
    const reviewerPayload = withReviewerPreview(payload, {
      asset: setup.snapshot.asset,
      timeframe: setup.snapshot.timeframe,
      scoreBefore: before.score,
      scoreAfter: next.score,
      includeReasoning: watch.include_reasoning,
    });
    await db.appendReplayEvent({
      sessionId,
      event: {
        setupId: setup.id,
        occurredAt: new Date(tickAt),
        stage: "reviewer",
        actor: r.provider,
        type,
        scoreDelta: next.score - before.score,
        scoreAfter: next.score,
        statusBefore: before.status,
        statusAfter: next.status,
        payload: reviewerPayload,
        provider: r.provider,
        model: r.model,
        promptVersion: r.promptVersion,
        latencyMs: null,
        cacheHit: r.cacheHit,
      },
    });

    if (isTerminal(next.status)) {
      alive.delete(setup.id);
    }
  }

  // 4) Finalizer for each FINALIZING setup.
  for (const setup of [...alive.values()]) {
    if (setup.runtime.status !== "FINALIZING") continue;
    if (overCap()) return { costUsd: tickCost };
    const f = await llm.runFinalizerReplay({
      sessionId,
      tickAt,
      setup: {
        ...setup.snapshot,
        currentScore: setup.runtime.score,
        invalidationLevel: setup.runtime.invalidationLevel,
      },
      latestIndicatorsJson: det.indicatorsJson,
      latestLastClose: det.lastClose,
    });
    tickCost += f.costUsd;
    const decision = JSON.parse(f.decisionJson) as {
      go: boolean;
      reasoning: string;
      entry?: number;
      stop_loss?: number;
      take_profit?: number[];
    };
    if (
      decision.go &&
      decision.entry !== undefined &&
      decision.stop_loss !== undefined &&
      decision.take_profit &&
      setup.snapshot.direction
    ) {
      const before = { ...setup.runtime };
      setup.runtime = { ...setup.runtime, status: "TRACKING" };
      setup.tracking = initialTrackingState({
        direction: setup.snapshot.direction,
        entry: decision.entry,
        stopLoss: decision.stop_loss,
        takeProfit: decision.take_profit,
        invalidationLevel: setup.snapshot.invalidationLevel ?? decision.stop_loss,
      });
      setup.scoreAtConfirmation = setup.runtime.score;
      const confirmedPreview = formatConfirmedPreview({
        asset: setup.snapshot.asset,
        timeframe: setup.snapshot.timeframe,
        direction: setup.snapshot.direction,
        entry: decision.entry,
        stopLoss: decision.stop_loss,
        takeProfit: decision.take_profit,
        reasoning: decision.reasoning,
        includeReasoning: watch.include_reasoning,
      });
      await db.appendReplayEvent({
        sessionId,
        event: {
          setupId: setup.id,
          occurredAt: new Date(tickAt),
          stage: "finalizer",
          actor: f.provider,
          type: "Confirmed",
          scoreDelta: 0,
          scoreAfter: setup.runtime.score,
          statusBefore: before.status,
          statusAfter: "TRACKING",
          payload: {
            type: "Confirmed",
            data: {
              decision: "GO",
              entry: decision.entry,
              stopLoss: decision.stop_loss,
              takeProfit: decision.take_profit,
              reasoning: decision.reasoning,
              telegramPreview: confirmedPreview,
            },
          },
          provider: f.provider,
          model: f.model,
          promptVersion: f.promptVersion,
          cacheHit: f.cacheHit,
        },
      });
    } else {
      const before = { ...setup.runtime };
      setup.runtime = { ...setup.runtime, status: "REJECTED" };
      const rejectedPreview = formatRejectedPreview({
        asset: setup.snapshot.asset,
        timeframe: setup.snapshot.timeframe,
        reasoning: decision.reasoning,
      });
      await db.appendReplayEvent({
        sessionId,
        event: {
          setupId: setup.id,
          occurredAt: new Date(tickAt),
          stage: "finalizer",
          actor: f.provider,
          type: "Rejected",
          scoreDelta: 0,
          scoreAfter: setup.runtime.score,
          statusBefore: before.status,
          statusAfter: "REJECTED",
          payload: {
            type: "Rejected",
            data: {
              decision: "NO_GO",
              reasoning: decision.reasoning,
              telegramPreview: rejectedPreview,
            },
          },
          provider: f.provider,
          model: f.model,
          promptVersion: f.promptVersion,
          cacheHit: f.cacheHit,
        },
      });
      alive.delete(setup.id);
    }
  }

  // 5) Intra-candle tracking simulation for TRACKING setups.
  const trackingSetups = [...alive.values()].filter(
    (s): s is AliveSetup & { tracking: TrackingState } =>
      s.runtime.status === "TRACKING" && s.tracking !== undefined,
  );
  if (trackingSetups.length > 0) {
    const from = prevTickAt ?? new Date(tickAtDate.getTime() - 1).toISOString();
    const { candles } = await db.fetchRangeCandles({ sessionId, from, to: tickAt });
    for (const candle of candles) {
      const parsedCandle = {
        timestamp: new Date(candle.timestamp),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
      for (const setup of trackingSetups) {
        if (setup.tracking.closed) continue;
        const events = simulateCandleTracking(setup.tracking, parsedCandle);
        for (const evt of events) {
          await persistTrackerEvent(db, sessionId, setup, evt);
        }
        if (setup.tracking.closed) {
          setup.runtime = {
            ...setup.runtime,
            status: setup.tracking.priceInvalidated ? "INVALIDATED" : "CLOSED",
          };
          const reason = closeReasonFromState(setup.tracking);
          if (reason !== null) {
            const feedback = await llm.runFeedbackAnalysisReplay({
              sessionId,
              setupId: setup.id,
              tickAt: parsedCandle.timestamp.toISOString(),
              closeReason: reason,
              everConfirmed: true,
              scoreAtClose: setup.scoreAtConfirmation ?? setup.runtime.score,
            });
            if (!feedback.skipped) tickCost += feedback.costUsd;
          }
          alive.delete(setup.id);
        }
      }
    }
  }

  return { costUsd: tickCost };
}

/**
 * Persists a single tracker event with the right discriminated-union
 * payload + Telegram preview. `db` is threaded through as a parameter so
 * the function is reusable in tests with fake activities.
 */
export async function persistTrackerEvent(
  db: ReplayActivityProxies,
  sessionId: string,
  setup: AliveSetup,
  evt: TrackerEvent,
): Promise<void> {
  const beforeStatus = setup.runtime.status;
  if (evt.kind === "EntryFilled") {
    await db.appendReplayEvent({
      sessionId,
      event: {
        setupId: setup.id,
        occurredAt: evt.observedAt,
        stage: "tracker",
        actor: "replay-tracker",
        type: "EntryFilled",
        scoreDelta: 0,
        scoreAfter: setup.runtime.score,
        statusBefore: beforeStatus,
        statusAfter: "TRACKING",
        payload: {
          type: "EntryFilled",
          data: { fillPrice: evt.fillPrice, observedAt: evt.observedAt.toISOString() },
        },
      },
    });
    return;
  }
  if (evt.kind === "TPHit") {
    const preview = formatTPHitPreview({
      asset: setup.snapshot.asset,
      timeframe: setup.snapshot.timeframe,
      level: evt.level,
      index: evt.index,
      isFinal: evt.isFinal,
    });
    await db.appendReplayEvent({
      sessionId,
      event: {
        setupId: setup.id,
        occurredAt: evt.observedAt,
        stage: "tracker",
        actor: "replay-tracker",
        type: "TPHit",
        scoreDelta: 0,
        scoreAfter: setup.runtime.score,
        statusBefore: beforeStatus,
        statusAfter: evt.isFinal ? "CLOSED" : "TRACKING",
        payload: {
          type: "TPHit",
          data: {
            level: evt.level,
            index: evt.index,
            observedAt: evt.observedAt.toISOString(),
            telegramPreview: preview,
          },
        },
      },
    });
    return;
  }
  if (evt.kind === "SLHit") {
    const preview = formatSLHitPreview({
      asset: setup.snapshot.asset,
      timeframe: setup.snapshot.timeframe,
      level: evt.level,
    });
    await db.appendReplayEvent({
      sessionId,
      event: {
        setupId: setup.id,
        occurredAt: evt.observedAt,
        stage: "tracker",
        actor: "replay-tracker",
        type: "SLHit",
        scoreDelta: 0,
        scoreAfter: setup.runtime.score,
        statusBefore: beforeStatus,
        statusAfter: "CLOSED",
        payload: {
          type: "SLHit",
          data: {
            level: evt.level,
            observedAt: evt.observedAt.toISOString(),
            telegramPreview: preview,
          },
        },
      },
    });
    return;
  }
  if (evt.kind === "PriceInvalidated") {
    const preview = formatInvalidatedAfterConfirmedPreview({
      asset: setup.snapshot.asset,
      timeframe: setup.snapshot.timeframe,
      reason: "price_below_invalidation",
    });
    await db.appendReplayEvent({
      sessionId,
      event: {
        setupId: setup.id,
        occurredAt: evt.observedAt,
        stage: "tracker",
        actor: "replay-tracker",
        type: "Invalidated",
        scoreDelta: 0,
        scoreAfter: setup.runtime.score,
        statusBefore: beforeStatus,
        statusAfter: "INVALIDATED",
        payload: {
          type: "Invalidated",
          data: {
            reason: "price_below_invalidation",
            trigger: "tracker",
            priceAtInvalidation: evt.currentPrice,
            invalidationLevel: evt.invalidationLevel,
            deterministic: true,
            telegramPreview: preview,
          },
        },
      },
    });
    return;
  }
  // TrailingMoved — no Telegram in live, no preview here.
  await db.appendReplayEvent({
    sessionId,
    event: {
      setupId: setup.id,
      occurredAt: evt.observedAt,
      stage: "tracker",
      actor: "replay-tracker",
      type: "TrailingMoved",
      scoreDelta: 0,
      scoreAfter: setup.runtime.score,
      statusBefore: beforeStatus,
      statusAfter: "TRACKING",
      payload: {
        type: "TrailingMoved",
        data: { newStopLoss: evt.newStopLoss, reason: evt.reason },
      },
    },
  });
}
/**
 * Returns a copy of the reviewer event payload with `telegramPreview`
 * attached when the verdict type would have triggered a notification in
 * live (Strengthened / Weakened).
 */
export function withReviewerPreview(
  payload: EventPayload,
  ctx: {
    asset: string;
    timeframe: string;
    scoreBefore: number;
    scoreAfter: number;
    includeReasoning: boolean;
  },
): EventPayload {
  if (payload.type === "Strengthened") {
    const preview = formatReviewerVerdictPreview({
      asset: ctx.asset,
      timeframe: ctx.timeframe,
      verdict: "STRENGTHEN",
      scoreBefore: ctx.scoreBefore,
      scoreAfter: ctx.scoreAfter,
      reasoning: payload.data.reasoning,
      includeReasoning: ctx.includeReasoning,
    });
    return { type: "Strengthened", data: { ...payload.data, telegramPreview: preview } };
  }
  if (payload.type === "Weakened") {
    const preview = formatReviewerVerdictPreview({
      asset: ctx.asset,
      timeframe: ctx.timeframe,
      verdict: "WEAKEN",
      scoreBefore: ctx.scoreBefore,
      scoreAfter: ctx.scoreAfter,
      reasoning: payload.data.reasoning,
      includeReasoning: ctx.includeReasoning,
    });
    return { type: "Weakened", data: { ...payload.data, telegramPreview: preview } };
  }
  return payload;
}

export type { SetupRuntimeState, SetupStatus };
