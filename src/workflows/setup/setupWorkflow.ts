import {
  CancellationScope,
  ChildWorkflowCancellationType,
  condition,
  defineQuery,
  defineSignal,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";
import type { EventPayload } from "../../domain/events/schemas";
import type { EventTypeName } from "../../domain/events/types";
import { deriveCloseOutcome, shouldTriggerFeedback } from "../../domain/feedback/closeOutcome";
import type { Verdict } from "../../domain/schemas/Verdict";
import { applyVerdict } from "../../domain/scoring/applyVerdict";
import type { SetupStatus } from "../../domain/state-machine/setupTransitions";
import { isActive } from "../../domain/state-machine/setupTransitions";
import { feedbackLoopWorkflow, feedbackWorkflowId } from "../feedback/feedbackLoopWorkflow";
import type * as activities from "./activities";
import { trackingLoop } from "./trackingLoop";

// Re-export the child workflow so a single workflowsPath (the analysis worker
// points at this file) bundles BOTH the parent setupWorkflow and the child
// feedbackLoopWorkflow. Without this re-export, Temporal cannot resolve the
// child workflow function by name at startChild time.
export { feedbackLoopWorkflow };

const SHARED_NON_RETRYABLE = [
  "InvalidConfigError",
  "AssetNotFoundError",
  "LLMSchemaValidationError",
  "PromptTooLargeError",
  "NoProviderAvailableError",
  "CircularFallbackError",
  "StopRequestedError",
];

// LLM activities — fewer attempts, longer timeouts (LLM calls are slow + expensive).
const llmActivities = proxyActivities<ReturnType<typeof activities.buildSetupActivities>>({
  startToCloseTimeout: "120s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    maximumInterval: "60s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

// DB / persistence activities — many fast retries (transient DB blips).
const dbActivities = proxyActivities<ReturnType<typeof activities.buildSetupActivities>>({
  startToCloseTimeout: "10s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "100ms",
    maximumInterval: "5s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

// Notify (Telegram) — moderate retries, short timeout.
const notifyActivities = proxyActivities<ReturnType<typeof activities.buildSetupActivities>>({
  startToCloseTimeout: "15s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "500ms",
    maximumInterval: "10s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

export type InitialEvidence = {
  setupId: string;
  watchId: string;
  asset: string;
  timeframe: string;
  patternHint: string;
  patternCategory: "event" | "accumulation";
  expectedMaturationTicks: number;
  /** Watch-level config — gates the same-tick detector→finalizer shortcut. */
  allowSameTickFastPath: boolean;
  direction: "LONG" | "SHORT";
  invalidationLevel: number;
  initialScore: number;
  ttlCandles: number;
  ttlExpiresAt: string;
  scoreThresholdFinalizer: number;
  scoreThresholdDead: number;
  scoreMax: number;
  detectorPromptVersion: string;
  /**
   * Whether the post-close feedback loop should be triggered for this setup.
   * Mirrors `watch.feedback.enabled` at the moment the setup is created;
   * captured here (vs. read live) so concurrent watch-config edits cannot
   * change a setup's feedback fate mid-flight.
   */
  feedbackEnabled: boolean;
  /**
   * Snapshot of `watch.include_reasoning` at setup-creation time. Captured
   * here (vs. read live in each notify activity) so a watch-config edit
   * between setup creation and reviewer verdict / confirmation cannot flip
   * the message format mid-setup. Same defensive pattern as `feedbackEnabled`.
   * Optional for back-compat with in-flight workflows whose history was
   * serialized before this field existed (notify activities fall back to
   * reading from `watch` in that case).
   */
  includeReasoning?: boolean;
  /**
   * Snapshot of `watch.include_chart_image` at setup-creation time. Same
   * rationale as `includeReasoning` above. Optional for back-compat.
   */
  includeChartImage?: boolean;
  /**
   * Detector's free-form natural-language observation that justified
   * proposing this setup. Forwarded to the setup-created Telegram
   * notification so the user can review the reasoning at glance.
   * Optional for back-compat with any in-flight workflows whose history
   * was serialized before this field existed.
   */
  rawObservation?: string;
  /**
   * URI of the chart snapshot rendered at detection time. Forwarded to the
   * setup-created Telegram notification. Optional for back-compat.
   */
  chartUri?: string;
};

export type ReviewSignalArgs = { tickSnapshotId: string };
export type CorroborateSignalArgs = { confidenceDelta: number; evidence: unknown };
export type PriceCheckSignalArgs = { currentPrice: number; observedAt: string };
export type CloseSignalArgs = { reason: string };
export type KillSignalArgs = { reason: string };

export const reviewSignal = defineSignal<[ReviewSignalArgs]>("review");
export const corroborateSignal = defineSignal<[CorroborateSignalArgs]>("corroborate");
export const priceCheckSignal = defineSignal<[PriceCheckSignalArgs]>("priceCheck");
export const closeSignal = defineSignal<[CloseSignalArgs]>("close");
export const killSignal = defineSignal<[KillSignalArgs]>("kill");

export type SetupWorkflowState = {
  status: SetupStatus;
  score: number;
  invalidationLevel: number;
  direction: "LONG" | "SHORT";
  sequence: number;
};

export const getStateQuery = defineQuery<SetupWorkflowState>("getState");

function verdictToEvent(verdict: Verdict): { type: EventTypeName; payload: EventPayload } {
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
          data: {
            reasoning: verdict.reasoning,
            observations: verdict.observations,
          },
        },
      };
    case "NEUTRAL":
      return {
        type: "Neutral",
        payload: {
          type: "Neutral",
          data: {
            observations: verdict.observations,
          },
        },
      };
    case "INVALIDATE":
      return {
        type: "Invalidated",
        payload: {
          type: "Invalidated",
          data: {
            reason: verdict.reason,
            trigger: "reviewer_verdict",
            deterministic: false,
          },
        },
      };
  }
}

export async function setupWorkflow(initial: InitialEvidence): Promise<SetupStatus> {
  const state: SetupWorkflowState = {
    status: "REVIEWING",
    score: initial.initialScore,
    invalidationLevel: initial.invalidationLevel,
    direction: initial.direction,
    sequence: 0,
  };

  // Tracks whether this setup ever transitioned to TRACKING (i.e. was confirmed)
  // so we can fire the post-confirmation invalidation notification only when due.
  let everConfirmed = false;

  // Register handlers before any await so signals/queries received during
  // workflow startup are not dropped.
  setHandler(getStateQuery, () => state);

  setHandler(reviewSignal, async (args) => {
    if (state.status !== "REVIEWING") return;
    const reviewerResult = await llmActivities.runReviewer({
      setupId: initial.setupId,
      tickSnapshotId: args.tickSnapshotId,
      watchId: initial.watchId,
    });

    if (reviewerResult.skipReason === "market_closed") return;
    if (reviewerResult.eventAlreadyExisted) return;

    const verdict = JSON.parse(reviewerResult.verdictJson) as Verdict;
    const before = {
      status: state.status,
      score: state.score,
      invalidationLevel: state.invalidationLevel,
      direction: state.direction,
    };
    const next = applyVerdict(before, verdict, {
      scoreMax: initial.scoreMax,
      scoreThresholdFinalizer: initial.scoreThresholdFinalizer,
      scoreThresholdDead: initial.scoreThresholdDead,
    });

    const { type, payload } = verdictToEvent(verdict);

    // Mutate in-memory state BEFORE persisting. The store assigns the
    // sequence atomically inside its transaction (Postgres MAX+1 / fake
    // counter), so concurrent state mutations from other handlers (e.g.
    // priceCheck flipping to INVALIDATED, or TTL flipping to EXPIRED)
    // cannot collide on the unique (setup_id, sequence) constraint.
    state.score = next.score;
    state.invalidationLevel = next.invalidationLevel;
    state.status = next.status;

    const stored = await dbActivities.persistEvent({
      event: {
        setupId: initial.setupId,
        stage: "reviewer",
        actor: reviewerResult.promptVersion,
        type,
        scoreDelta: next.score - before.score,
        scoreAfter: next.score,
        statusBefore: before.status,
        statusAfter: next.status,
        payload,
        provider: reviewerResult.provider,
        model: reviewerResult.model,
        promptVersion: reviewerResult.promptVersion,
        inputHash: reviewerResult.inputHash,
      },
      setupUpdate: {
        score: next.score,
        status: next.status,
        invalidationLevel: next.invalidationLevel,
      },
    });
    state.sequence = stored.sequence;

    // Reviewer-verdict notification (gated on watch.notify_on inside the
    // activity). Only STRENGTHEN/WEAKEN trigger this — NEUTRAL is silent and
    // INVALIDATE has its own deterministic-invalidation path.
    if (verdict.type === "STRENGTHEN" || verdict.type === "WEAKEN") {
      await notifyActivities.notifyTelegramReviewerVerdict({
        watchId: initial.watchId,
        asset: initial.asset,
        timeframe: initial.timeframe,
        setupId: initial.setupId,
        verdict: verdict.type,
        scoreDelta: next.score - before.score,
        scoreAfter: next.score,
        reasoning: verdict.reasoning,
        includeReasoning: initial.includeReasoning,
      });
    }
  });

  setHandler(corroborateSignal, async (args) => {
    if (state.status !== "REVIEWING") return;
    const before = { status: state.status, score: state.score };
    const newScore = Math.min(initial.scoreMax, state.score + args.confidenceDelta);
    const newStatus: SetupStatus =
      newScore >= initial.scoreThresholdFinalizer ? "FINALIZING" : before.status;

    const stored = await dbActivities.persistEvent({
      event: {
        setupId: initial.setupId,
        stage: "detector",
        actor: initial.detectorPromptVersion,
        type: "Strengthened",
        scoreDelta: newScore - before.score,
        scoreAfter: newScore,
        statusBefore: before.status,
        statusAfter: newStatus,
        payload: {
          type: "Strengthened",
          data: {
            reasoning: "Corroborating evidence from detector",
            observations: [],
            source: "detector_corroboration",
          },
        },
      },
      setupUpdate: {
        score: newScore,
        status: newStatus,
        invalidationLevel: state.invalidationLevel,
      },
    });

    state.sequence = stored.sequence;
    state.score = newScore;
    // Flip status LAST so active loop sees the new state only after persist commits.
    state.status = newStatus;
  });

  setHandler(priceCheckSignal, async (args) => {
    // In TRACKING phase, the trackingLoop has its own `trackingPrice` handler.
    // The priceMonitor activity dispatches signal name based on status, but if a
    // stale priceCheck arrives during TRACKING we no-op (no invalidation logic).
    if (state.status === "TRACKING") return;

    const breached =
      (state.direction === "LONG" && args.currentPrice < state.invalidationLevel) ||
      (state.direction === "SHORT" && args.currentPrice > state.invalidationLevel);
    if (!breached) return;
    if (!isActive(state.status)) return;

    const before = { status: state.status, score: state.score };

    const stored = await dbActivities.persistEvent({
      event: {
        setupId: initial.setupId,
        stage: "system",
        actor: "price_monitor",
        type: "PriceInvalidated",
        scoreDelta: 0,
        scoreAfter: before.score,
        statusBefore: before.status,
        statusAfter: "INVALIDATED",
        payload: {
          type: "PriceInvalidated",
          data: {
            currentPrice: args.currentPrice,
            invalidationLevel: state.invalidationLevel,
            observedAt: args.observedAt,
          },
        },
      },
      setupUpdate: {
        score: before.score,
        status: "INVALIDATED",
        invalidationLevel: state.invalidationLevel,
      },
    });

    state.sequence = stored.sequence;
    state.status = "INVALIDATED";

    if (everConfirmed) {
      await notifyActivities.notifyTelegramInvalidatedAfterConfirmed({
        watchId: initial.watchId,
        asset: initial.asset,
        timeframe: initial.timeframe,
        reason: "price_below_invalidation",
      });
    }
  });

  setHandler(closeSignal, () => {
    state.status = "CLOSED";
  });

  // User kill via Telegram inline button. The signal payload is a flag — the
  // active loop polls it after each wait point and performs the actual
  // persist + notify in a non-cancellable scope so a concurrent TTL or
  // priceCheck flip cannot drop the Killed event mid-flight. We do NOT do
  // the kill work inline in the signal handler because that runs
  // concurrently with the main flow and would race the active loop.
  let killRequested: { reason: string } | null = null;
  setHandler(killSignal, (args) => {
    // Only the latest kill wins (idempotent — repeated clicks are no-ops).
    if (killRequested) return;
    killRequested = { reason: args.reason };
  });

  // Create the setup row first so subsequent events satisfy the FK.
  await dbActivities.createSetup({
    setupId: initial.setupId,
    watchId: initial.watchId,
    asset: initial.asset,
    timeframe: initial.timeframe,
    patternHint: initial.patternHint,
    patternCategory: initial.patternCategory,
    expectedMaturationTicks: initial.expectedMaturationTicks,
    invalidationLevel: initial.invalidationLevel,
    direction: initial.direction,
    ttlCandles: initial.ttlCandles,
    ttlExpiresAt: initial.ttlExpiresAt,
    initialScore: initial.initialScore,
    workflowId: workflowInfo().workflowId,
  });

  // Persist SetupCreated event — store assigns sequence atomically.
  const createdEvt = await dbActivities.persistEvent({
    event: {
      setupId: initial.setupId,
      stage: "detector",
      actor: initial.detectorPromptVersion,
      type: "SetupCreated",
      scoreDelta: 0,
      scoreAfter: state.score,
      statusBefore: "CANDIDATE",
      statusAfter: "REVIEWING",
      payload: {
        type: "SetupCreated",
        data: {
          pattern: initial.patternHint,
          direction: initial.direction,
          keyLevels: { invalidation: initial.invalidationLevel },
          initialScore: initial.initialScore,
          rawObservation: initial.rawObservation ?? "Initial detection",
        },
      },
    },
    setupUpdate: {
      score: state.score,
      status: state.status,
      invalidationLevel: state.invalidationLevel,
    },
  });
  state.sequence = createdEvt.sequence;

  // Setup-created Telegram notification (gated on watch.notify_on inside the
  // activity). Sends BEFORE the same-tick fast-path so the user always sees
  // a kill button — even on instant-finalize setups, the notification is
  // best-effort and racing against finalizer completion is acceptable
  // (the kill signal handler is idempotent and a no-op past terminal state).
  await notifyActivities.notifyTelegramSetupCreated({
    watchId: initial.watchId,
    asset: initial.asset,
    timeframe: initial.timeframe,
    setupId: initial.setupId,
    patternHint: initial.patternHint,
    direction: initial.direction,
    initialScore: initial.initialScore,
    rawObservation: initial.rawObservation ?? "Initial detection",
    invalidationLevel: initial.invalidationLevel,
    chartUri: initial.chartUri,
    includeChartImage: initial.includeChartImage,
  });

  // Helper: poll-and-apply for the killSignal. Called after every async wait
  // point in the active loop. Persists the Killed event + sends confirmation
  // notification, and flips state.status to KILLED so the active loop's
  // `isActive` check exits. Idempotent — repeated invocations after the
  // first kill are no-ops.
  async function applyKillIfRequested(): Promise<boolean> {
    if (!killRequested) return false;
    if (!isActive(state.status)) return false;
    const reason = killRequested.reason;
    // Clear the flag eagerly so any concurrent re-entry from another await
    // bails out via the early returns above.
    killRequested = null;

    await CancellationScope.nonCancellable(async () => {
      const stored = await dbActivities.killSetup({ setupId: initial.setupId, reason });
      // Maintain the `sequence` invariant other persist activities preserve.
      // killSetup returns null on the no-op path (setup already terminal) —
      // skip the assignment in that case (the upstream terminal transition
      // already advanced state.sequence). Defensive null/undefined check
      // because some workflow histories may have been replayed past this
      // point with a void-returning fake activity.
      if (stored != null) {
        state.sequence = stored.sequence;
      }
      state.status = "KILLED";
      await notifyActivities.notifyTelegramSetupKilled({
        watchId: initial.watchId,
        asset: initial.asset,
        timeframe: initial.timeframe,
        setupId: initial.setupId,
      });
    });
    return true;
  }

  // The handler may have been delivered before this point (e.g. while the
  // SetupCreated persist + notification were in flight). Apply once now so
  // we do not enter the active loop on an already-killed setup.
  await applyKillIfRequested();

  // Same-tick fast-path for high-conviction event setups.
  // If the detector emitted a setup that already meets the finalizer
  // threshold AND declared a 1-tick maturation, route directly to the
  // finalizer in this same workflow tick — skip the reviewer entirely.
  // Rationale: a clean liquidity-sweep + reclaim or BB-squeeze break is
  // fully formed at proposal time; waiting one full reviewer tick (15min
  // on a 15m TF) gives away most of the move. The architectural guard:
  // BOTH score ≥ threshold AND maturation = 1 must hold; either alone is
  // not sufficient (high score without instant maturation = needs at
  // least 1 follow-through tick; instant maturation without high score =
  // not yet finalizer-eligible).
  if (
    initial.allowSameTickFastPath &&
    state.score >= initial.scoreThresholdFinalizer &&
    initial.expectedMaturationTicks === 1 &&
    state.status === "REVIEWING"
  ) {
    state.status = "FINALIZING";
  }

  // TTL timer (Temporal-native, durable). Runs in a cancellable scope so we
  // can stop it as soon as the workflow leaves an active state.
  const ttlMs = new Date(initial.ttlExpiresAt).getTime() - Date.now();
  const ttlScope = new CancellationScope();
  ttlScope
    .run(async () => {
      if (ttlMs > 0) await sleep(ttlMs);
      if (state.status === "REVIEWING" || state.status === "FINALIZING") {
        // Persist + notify in a non-cancellable inner scope so that the active
        // loop's `finally { ttlScope.cancel() }` (which fires when the loop
        // observes state.status flip to EXPIRED) cannot cancel the in-flight
        // activities mid-flight. Without this guard the Expired event and
        // Telegram notification could be dropped on a race.
        await CancellationScope.nonCancellable(async () => {
          const before = state.status;
          // For the TTL handler we flip state BEFORE persist (in a
          // non-cancellable scope). This is intentional: it ensures the
          // active loop observes EXPIRED and exits even if persist transiently
          // fails — the persist activity itself retries idempotently.
          state.status = "EXPIRED";
          const stored = await dbActivities.persistEvent({
            event: {
              setupId: initial.setupId,
              stage: "system",
              actor: "ttl",
              type: "Expired",
              scoreDelta: 0,
              scoreAfter: state.score,
              statusBefore: before,
              statusAfter: "EXPIRED",
              payload: {
                type: "Expired",
                data: {
                  reason: "ttl_reached",
                  ttlExpiresAt: initial.ttlExpiresAt,
                },
              },
            },
            setupUpdate: {
              score: state.score,
              status: "EXPIRED",
              invalidationLevel: state.invalidationLevel,
            },
          });
          state.sequence = stored.sequence;
          await notifyActivities.notifyTelegramExpired({
            watchId: initial.watchId,
            asset: initial.asset,
            timeframe: initial.timeframe,
          });
        });
      }
    })
    .catch(() => {
      /* cancelled */
    });

  // Active loop
  try {
    while (isActive(state.status)) {
      await condition(
        () => !isActive(state.status) || state.status === "FINALIZING" || killRequested !== null,
      );

      if (await applyKillIfRequested()) continue;

      if (state.status === "FINALIZING") {
        const finalizerResult = await llmActivities.runFinalizer({
          setupId: initial.setupId,
          watchId: initial.watchId,
        });

        if (finalizerResult.skipReason === "market_closed") {
          // Market is closed; back off and re-evaluate when the condition
          // unblocks again (state.status === "FINALIZING" stays true so the
          // loop immediately re-enters after the sleep, by which point the
          // market may have reopened). Phase 5 provides Schedule-pause-driven
          // gating upstream; this is a defensive fallback.
          await sleep("5m");
          continue;
        }

        const finalizerPromptVersion = finalizerResult.promptVersion;
        const decision = JSON.parse(finalizerResult.decisionJson) as {
          go: boolean;
          reasoning: string;
          entry?: number;
          stop_loss?: number;
          take_profit?: number[];
        };
        if (decision.go) {
          const stored = await dbActivities.persistEvent({
            event: {
              setupId: initial.setupId,
              stage: "finalizer",
              actor: finalizerPromptVersion,
              type: "Confirmed",
              scoreDelta: 0,
              scoreAfter: state.score,
              statusBefore: "FINALIZING",
              statusAfter: "TRACKING",
              payload: {
                type: "Confirmed",
                data: {
                  decision: "GO",
                  entry: decision.entry ?? 0,
                  stopLoss: decision.stop_loss ?? 0,
                  takeProfit:
                    decision.take_profit && decision.take_profit.length > 0
                      ? decision.take_profit
                      : [0],
                  reasoning: decision.reasoning,
                },
              },
            },
            setupUpdate: {
              score: state.score,
              status: "TRACKING",
              invalidationLevel: state.invalidationLevel,
            },
          });
          state.sequence = stored.sequence;
          state.status = "TRACKING";
          everConfirmed = true;
          await notifyActivities.notifyTelegramConfirmed({
            watchId: initial.watchId,
            asset: initial.asset,
            timeframe: initial.timeframe,
            direction: initial.direction,
            entry: decision.entry ?? 0,
            stopLoss: decision.stop_loss ?? 0,
            takeProfit: decision.take_profit ?? [],
            reasoning: decision.reasoning,
            includeReasoning: initial.includeReasoning,
            includeChartImage: initial.includeChartImage,
          });
          const trackingResult = await trackingLoop({
            setupId: initial.setupId,
            watchId: initial.watchId,
            asset: initial.asset,
            timeframe: initial.timeframe,
            direction: initial.direction,
            entry: decision.entry ?? 0,
            stopLoss: decision.stop_loss ?? 0,
            invalidationLevel: state.invalidationLevel,
            takeProfit: decision.take_profit ?? [],
            scoreAtConfirmation: state.score,
          });
          // trackingLoop updates DB but not workflow state — sync here so the
          // active loop exits cleanly instead of blocking on `condition`.
          // `price_invalidated` ⇒ status INVALIDATED; everything else ⇒ CLOSED.
          state.status = trackingResult.reason === "price_invalidated" ? "INVALIDATED" : "CLOSED";

          // Trigger the feedback loop on eligible close reasons. The child
          // runs with parentClosePolicy:ABANDON so the parent setup workflow
          // can complete immediately even if the feedback loop is still
          // running — feedback analysis must not block the trading hot path.
          if (initial.feedbackEnabled) {
            const closeOutcome = deriveCloseOutcome({
              finalStatus: "CLOSED",
              trackingResult,
              everConfirmed: true,
            });
            if (shouldTriggerFeedback(closeOutcome)) {
              await startChild(feedbackLoopWorkflow, {
                workflowId: feedbackWorkflowId(initial.setupId),
                args: [
                  {
                    setupId: initial.setupId,
                    watchId: initial.watchId,
                    closeOutcome,
                    scoreAtClose: state.score,
                  },
                ],
                parentClosePolicy: ParentClosePolicy.ABANDON,
                cancellationType: ChildWorkflowCancellationType.ABANDON,
              });
            }
          }
        } else {
          const stored = await dbActivities.persistEvent({
            event: {
              setupId: initial.setupId,
              stage: "finalizer",
              actor: finalizerPromptVersion,
              type: "Rejected",
              scoreDelta: 0,
              scoreAfter: state.score,
              statusBefore: "FINALIZING",
              statusAfter: "REJECTED",
              payload: {
                type: "Rejected",
                data: {
                  decision: "NO_GO",
                  reasoning: decision.reasoning,
                },
              },
            },
            setupUpdate: {
              score: state.score,
              status: "REJECTED",
              invalidationLevel: state.invalidationLevel,
            },
          });
          state.sequence = stored.sequence;
          state.status = "REJECTED";
          await notifyActivities.notifyTelegramRejected({
            watchId: initial.watchId,
            asset: initial.asset,
            timeframe: initial.timeframe,
            reasoning: decision.reasoning,
          });
        }
      }
    }
  } finally {
    ttlScope.cancel();
  }

  await dbActivities.markSetupClosed({ setupId: initial.setupId, finalStatus: state.status });
  return state.status;
}

export const setupWorkflowId = (id: string) => `setup-${id}`;
