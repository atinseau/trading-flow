import {
  formatConfirmedPreview,
  formatExpiredPreview,
  formatRejectedPreview,
  formatReviewerVerdictPreview,
  formatSLHitPreview,
  formatSetupCreatedPreview,
  formatTPHitPreview,
} from "@domain/notify/formatReplayTelegramPreview";
import {
  closeReasonFromState,
  initialTrackingState,
  simulateCandleTracking,
  type TrackingState,
} from "@domain/replay/simulateTracking";
import type { Verdict } from "@domain/schemas/Verdict";
import { applyVerdict, type SetupRuntimeState } from "@domain/scoring/applyVerdict";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import { isTerminal } from "@domain/state-machine/setupTransitions";
import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  uuid4,
} from "@temporalio/workflow";
import type * as replayActivities from "./activities";
import type { ReplaySetupSnapshot } from "./activities";

/**
 * Long-running Temporal workflow for a replay session.
 *
 * One workflow instance per `replay_sessions` row. Stays alive idle,
 * waking on user-driven signals from the API:
 *
 *  - `replayTickSignal({ tickAt })` — advance the playhead by one candle.
 *  - `pauseSignal` / `resumeSignal` — gate further tick processing.
 *  - `terminateSignal` — clean exit + status update.
 *
 * The golden rule (spec §1): NOTHING is automatic. The workflow only acts
 * when the user clicks "Step" (which triggers `replayTickSignal` via the
 * API). No timers, no auto-advance.
 *
 * v1 scope (J2): Detector → Reviewer → Finalizer pipeline. Setups can
 * reach CONFIRMED or REJECTED but trade lifecycle (EntryFilled/TPHit/SLHit)
 * and feedback-on-close are deferred to v2 — they need intra-candle
 * simulation which is its own subsystem.
 */

// --- Signal / query schemas --------------------------------------------------

export type ReplaySessionWorkflowArgs = {
  sessionId: string;
};

export type ReplayTickSignalArgs = {
  /** ISO date of the candle close that this tick refers to. */
  tickAt: string;
};

export const replayTickSignal = defineSignal<[ReplayTickSignalArgs]>("replayTick");
export const pauseSignal = defineSignal<[]>("pause");
export const resumeSignal = defineSignal<[]>("resume");
export const terminateSignal = defineSignal<[{ reason?: string }]>("terminate");

export type AliveSetupView = {
  id: string;
  status: SetupStatus;
  score: number;
  invalidationLevel: number;
  direction: "LONG" | "SHORT";
  patternHint: string | null;
};

export type ReplayWorkflowState = {
  /** Current session status as far as the workflow knows. */
  status: "READY" | "PAUSED" | "COMPLETED" | "COST_CAPPED" | "FAILED";
  /** ISO of the last processed tick (null until first tick succeeds). */
  lastTickAt: string | null;
  /** Snapshot of currently-alive setups. */
  aliveSetups: AliveSetupView[];
  /** Cumulative cost as seen by the workflow (sessionsRepo is source of truth). */
  costUsdSoFar: number;
  /** True iff a tick is currently in flight. */
  tickInProgress: boolean;
  /** Queue depth — useful for UI debugging. */
  pendingTicks: number;
};

export const getReplayStateQuery = defineQuery<ReplayWorkflowState>("getReplayState");

// --- Activity proxies --------------------------------------------------------

const NON_RETRYABLE = [
  "InvalidConfigError",
  "AssetNotFoundError",
  "LLMSchemaValidationError",
  "NoProviderAvailableError",
  "CircularFallbackError",
];

const llm = proxyActivities<ReturnType<typeof replayActivities.buildReplayActivities>>({
  startToCloseTimeout: "180s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    maximumInterval: "60s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: NON_RETRYABLE,
  },
});

const db = proxyActivities<ReturnType<typeof replayActivities.buildReplayActivities>>({
  startToCloseTimeout: "20s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "200ms",
    maximumInterval: "5s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: NON_RETRYABLE,
  },
});

// --- Workflow body -----------------------------------------------------------

type AliveSetup = {
  id: string;
  snapshot: ReplaySetupSnapshot;
  runtime: SetupRuntimeState;
  /** Wall-clock deadline at which this setup expires (TTL in candles × timeframe ms). */
  ttlExpiresAt: Date;
  /** Trade tracker state — set when the setup is confirmed (status === TRACKING). */
  tracking?: TrackingState;
  /** Captured when Confirmed fires so feedback knows the score-at-close. */
  scoreAtConfirmation?: number;
};

export async function replaySessionWorkflow(args: ReplaySessionWorkflowArgs): Promise<void> {
  // Load the session once at start. Config snapshot is immutable for the
  // session's lifetime (spec §10 invariant 5), so we trust the cached copy.
  const { session } = await db.loadReplaySession({ sessionId: args.sessionId });
  const watch = session.configSnapshot;

  const queue: string[] = [];
  let paused = session.status === "PAUSED";
  let terminated = false;
  let tickInProgress = false;
  let lastTickAt: string | null = null;
  let costUsdSoFar = session.costUsdSoFar;
  let status: ReplayWorkflowState["status"] =
    session.status === "READY" ||
    session.status === "PAUSED" ||
    session.status === "COMPLETED" ||
    session.status === "COST_CAPPED" ||
    session.status === "FAILED"
      ? session.status
      : "READY";
  const alive = new Map<string, AliveSetup>();

  // ----- signal/query handlers must be registered before any await. -----

  setHandler(replayTickSignal, (a) => {
    if (terminated || status === "COMPLETED" || status === "FAILED") return;
    queue.push(a.tickAt);
  });
  setHandler(pauseSignal, () => {
    paused = true;
    if (status === "READY") status = "PAUSED";
  });
  setHandler(resumeSignal, () => {
    paused = false;
    if (status === "PAUSED") status = "READY";
  });
  setHandler(terminateSignal, (a) => {
    terminated = true;
    if (status === "READY" || status === "PAUSED") {
      status = "FAILED";
      // Fire-and-forget the persist; workflow exits in the main loop on
      // next condition check.
      void db
        .updateReplaySessionStatus({
          sessionId: args.sessionId,
          status: "FAILED",
          failureReason: a.reason ?? "user_terminated",
        })
        .catch(() => undefined);
    }
  });
  setHandler(getReplayStateQuery, () => ({
    status,
    lastTickAt,
    aliveSetups: [...alive.values()].map((s) => ({
      id: s.id,
      status: s.runtime.status,
      score: s.runtime.score,
      invalidationLevel: s.runtime.invalidationLevel,
      direction: s.runtime.direction,
      patternHint: s.snapshot.patternHint,
    })),
    costUsdSoFar,
    tickInProgress,
    pendingTicks: queue.length,
  }));

  // ----- main loop: drain the tick queue, respecting pause/terminate ----

  while (!terminated && status !== "COMPLETED" && status !== "FAILED") {
    await condition(() => terminated || (queue.length > 0 && !paused && status !== "COST_CAPPED"));
    if (terminated) break;
    const next = queue.shift();
    if (!next) continue;
    const tickAt = next;
    tickInProgress = true;
    try {
      const cost = await processTick(args.sessionId, watch, tickAt, alive, lastTickAt);
      costUsdSoFar += cost;
      lastTickAt = tickAt;

      // Cost-cap guard: pause processing if the user has burned through
      // their budget. Resumes only after the user raises the cap and
      // restarts the workflow (sessionsRepo.incrementCost is already
      // honored by the activities themselves).
      if (costUsdSoFar >= session.costCapUsd) {
        status = "COST_CAPPED";
        await db.updateReplaySessionStatus({
          sessionId: args.sessionId,
          status: "COST_CAPPED",
        });
      }

      // Completion guard: if we've reached the window end, finalize.
      if (new Date(tickAt) >= session.windowEndAt) {
        status = "COMPLETED";
        await db.updateReplaySessionStatus({
          sessionId: args.sessionId,
          status: "COMPLETED",
        });
      }
    } catch (err) {
      status = "FAILED";
      await db.updateReplaySessionStatus({
        sessionId: args.sessionId,
        status: "FAILED",
        failureReason: (err as Error).message ?? "unknown",
      });
      break;
    } finally {
      tickInProgress = false;
    }
  }
}

// --- Tick orchestration ------------------------------------------------------

/**
 * Timeframe → minutes lookup, mirrors `domain/replay/replaySessionRules`.
 * Inlined here so the workflow bundle stays free of the schema tree.
 */
function timeframeMinutes(tf: string): number {
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

async function processTick(
  sessionId: string,
  watch: import("@domain/schemas/WatchesConfig").WatchConfig,
  tickAt: string,
  alive: Map<string, AliveSetup>,
  prevTickAt: string | null,
): Promise<number> {
  let tickCost = 0;
  const tickAtDate = new Date(tickAt);

  // -------- 0. TTL expiry check (before any LLM call) --------
  // Setups whose TTL has lapsed by `tickAt` are expired without consuming
  // detector / reviewer budget. Walk a snapshot of values because we mutate
  // the map during the loop.
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

  // 1) Detector tick — always runs.
  const det = await llm.runDetectorReplay({
    sessionId,
    tickAt,
    aliveSetups: aliveSnapshot,
  });
  tickCost += det.costUsd;

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

  // 2) Persist SetupCreated for each new setup, register in alive map.
  for (const ns of newSetups) {
    const setupId = uuid4();
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

  // 3) For each REVIEWING setup, run the reviewer and apply the verdict.
  for (const setup of [...alive.values()]) {
    if (setup.runtime.status !== "REVIEWING") continue;
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
    // Attach a Telegram preview for the verdict types that would have
    // notified the user in live (STRENGTHEN / WEAKEN). NEUTRAL is silent
    // in live and stays silent in replay ; INVALIDATE has its own
    // post-confirmation preview but we don't synthesize one in the
    // pre-confirmation phase.
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

  // 4) For each FINALIZING setup, run the finalizer.
  for (const setup of [...alive.values()]) {
    if (setup.runtime.status !== "FINALIZING") continue;
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
      });
      setup.scoreAtConfirmation = setup.runtime.score;
      const confirmedPreview = setup.snapshot.direction
        ? formatConfirmedPreview({
            asset: setup.snapshot.asset,
            timeframe: setup.snapshot.timeframe,
            direction: setup.snapshot.direction,
            entry: decision.entry,
            stopLoss: decision.stop_loss,
            takeProfit: decision.take_profit,
            reasoning: decision.reasoning,
            includeReasoning: watch.include_reasoning,
          })
        : undefined;
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
      // v1: TRACKING is left in the alive map but inert (no intra-candle
      // sim yet). v2 will simulate EntryFilled/TPHit/SLHit per candle and
      // close + fire feedback.
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
  //    Fetches the candles in (prevTickAt, tickAt] and applies the
  //    deterministic SL-prioritaire convention via simulateCandleTracking.
  //    Setups that just transitioned to TRACKING in step 4 of the SAME tick
  //    are included — `prevTickAt` defines the window left bound, and the
  //    tracking state was set at finalizer time before this phase runs.
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
          await persistTrackerEvent(sessionId, setup, evt);
        }
        if (setup.tracking.closed) {
          // Mark setup as CLOSED in the runtime state ; finalize the close.
          setup.runtime = { ...setup.runtime, status: "CLOSED" };
          const reason = closeReasonFromState(setup.tracking);
          if (reason !== null) {
            // Trigger feedback analysis (Wiring 4). The activity itself
            // honors `feedbackMode === "skip"` and short-circuits.
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

  return tickCost;
}

/**
 * Persists a single tracker event (EntryFilled/TPHit/SLHit/TrailingMoved)
 * with the right discriminated-union shape + Telegram preview. Helper
 * extracted so `processTick` stays scannable.
 */
async function persistTrackerEvent(
  sessionId: string,
  setup: AliveSetup,
  evt: import("@domain/replay/simulateTracking").TrackerEvent,
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
  // TrailingMoved — no Telegram in live, no preview here.
  await db.appendReplayEvent({
    sessionId,
    event: {
      setupId: setup.id,
      occurredAt: new Date(),
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

function verdictToEvent(verdict: Verdict): {
  type: string;
  payload: import("@domain/events/schemas").EventPayload;
} {
  switch (verdict.type) {
    case "STRENGTHEN":
      return {
        type: "Strengthened",
        payload: {
          type: "Strengthened",
          data: {
            reasoning: verdict.reasoning,
            observations: verdict.observations,
            source: "reviewer_full",
          },
        },
      };
    case "WEAKEN":
      return {
        type: "Weakened",
        payload: {
          type: "Weakened",
          data: { reasoning: verdict.reasoning, observations: verdict.observations },
        },
      };
    case "NEUTRAL":
      return {
        type: "Neutral",
        payload: { type: "Neutral", data: { observations: verdict.observations } },
      };
    case "INVALIDATE":
      return {
        type: "Invalidated",
        payload: {
          type: "Invalidated",
          data: { reason: verdict.reason, trigger: "reviewer_verdict", deterministic: false },
        },
      };
  }
}

/**
 * Returns a copy of the reviewer event payload with `telegramPreview`
 * attached when the verdict type would have triggered a Telegram
 * notification in live (Strengthened / Weakened). NEUTRAL and
 * Invalidated stay untouched — live emits no message for the former,
 * and the latter has its own preview path when fired post-confirmation.
 */
function withReviewerPreview(
  payload: import("@domain/events/schemas").EventPayload,
  ctx: {
    asset: string;
    timeframe: string;
    scoreBefore: number;
    scoreAfter: number;
    includeReasoning: boolean;
  },
): import("@domain/events/schemas").EventPayload {
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

export const replaySessionWorkflowId = (sessionId: string) => `replay-session-${sessionId}`;
