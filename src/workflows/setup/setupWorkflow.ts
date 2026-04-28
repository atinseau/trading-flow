import {
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { EventPayload } from "../../domain/events/schemas";
import type { EventTypeName } from "../../domain/events/types";
import type { Verdict } from "../../domain/schemas/Verdict";
import { applyVerdict } from "../../domain/scoring/applyVerdict";
import type { SetupStatus } from "../../domain/state-machine/setupTransitions";
import { isActive } from "../../domain/state-machine/setupTransitions";
import type * as activities from "./activities";
import { trackingLoop } from "./trackingLoop";

const a = proxyActivities<ReturnType<typeof activities.buildSetupActivities>>({
  startToCloseTimeout: "60s",
  retry: { maximumAttempts: 3 },
});

export type InitialEvidence = {
  setupId: string;
  watchId: string;
  asset: string;
  timeframe: string;
  patternHint: string;
  direction: "LONG" | "SHORT";
  invalidationLevel: number;
  initialScore: number;
  ttlCandles: number;
  ttlExpiresAt: string;
  scoreThresholdFinalizer: number;
  scoreThresholdDead: number;
  scoreMax: number;
};

export type ReviewSignalArgs = { tickSnapshotId: string };
export type CorroborateSignalArgs = { confidenceDelta: number; evidence: unknown };
export type PriceCheckSignalArgs = { currentPrice: number; observedAt: string };
export type CloseSignalArgs = { reason: string };

export const reviewSignal = defineSignal<[ReviewSignalArgs]>("review");
export const corroborateSignal = defineSignal<[CorroborateSignalArgs]>("corroborate");
export const priceCheckSignal = defineSignal<[PriceCheckSignalArgs]>("priceCheck");
export const closeSignal = defineSignal<[CloseSignalArgs]>("close");

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
    const reviewerResult = await a.runReviewer({
      setupId: initial.setupId,
      tickSnapshotId: args.tickSnapshotId,
      watchId: initial.watchId,
    });

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

    const seq = (await a.nextSequence({ setupId: initial.setupId })).sequence;
    const { type, payload } = verdictToEvent(verdict);

    // Update in-memory state BEFORE persisting so concurrent timer scopes
    // (e.g. TTL) see the new status and don't override it.
    state.sequence = seq;
    state.status = next.status;
    state.score = next.score;
    state.invalidationLevel = next.invalidationLevel;

    await a.persistEvent({
      event: {
        setupId: initial.setupId,
        sequence: seq,
        stage: "reviewer",
        actor: "reviewer_v1",
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
        costUsd: reviewerResult.costUsd,
      },
      setupUpdate: {
        score: next.score,
        status: next.status,
        invalidationLevel: next.invalidationLevel,
      },
    });
  });

  setHandler(corroborateSignal, async (args) => {
    if (state.status !== "REVIEWING") return;
    const before = { status: state.status, score: state.score };
    const newScore = Math.min(initial.scoreMax, state.score + args.confidenceDelta);
    const newStatus: SetupStatus =
      newScore >= initial.scoreThresholdFinalizer ? "FINALIZING" : before.status;

    const seq = (await a.nextSequence({ setupId: initial.setupId })).sequence;
    state.sequence = seq;
    state.score = newScore;
    state.status = newStatus;

    await a.persistEvent({
      event: {
        setupId: initial.setupId,
        sequence: seq,
        stage: "detector",
        actor: "detector_v1",
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
  });

  setHandler(priceCheckSignal, async (args) => {
    const breached =
      (state.direction === "LONG" && args.currentPrice < state.invalidationLevel) ||
      (state.direction === "SHORT" && args.currentPrice > state.invalidationLevel);
    if (!breached) return;
    if (!isActive(state.status)) return;

    const before = { status: state.status, score: state.score };
    const seq = (await a.nextSequence({ setupId: initial.setupId })).sequence;
    state.sequence = seq;
    state.status = "INVALIDATED";

    await a.persistEvent({
      event: {
        setupId: initial.setupId,
        sequence: seq,
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

    if (everConfirmed) {
      await a.notifyTelegramInvalidatedAfterConfirmed({
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

  // Create the setup row first so subsequent events satisfy the FK.
  await a.createSetup({
    setupId: initial.setupId,
    watchId: initial.watchId,
    asset: initial.asset,
    timeframe: initial.timeframe,
    patternHint: initial.patternHint,
    invalidationLevel: initial.invalidationLevel,
    direction: initial.direction,
    ttlCandles: initial.ttlCandles,
    ttlExpiresAt: initial.ttlExpiresAt,
    initialScore: initial.initialScore,
    workflowId: workflowInfo().workflowId,
  });

  // Persist SetupCreated event
  state.sequence = (await a.nextSequence({ setupId: initial.setupId })).sequence;
  await a.persistEvent({
    event: {
      setupId: initial.setupId,
      sequence: state.sequence,
      stage: "detector",
      actor: "detector_v1",
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
          rawObservation: "Initial detection",
        },
      },
    },
    setupUpdate: {
      score: state.score,
      status: state.status,
      invalidationLevel: state.invalidationLevel,
    },
  });

  // TTL timer (Temporal-native, durable). Runs in a cancellable scope so we
  // can stop it as soon as the workflow leaves an active state.
  const ttlMs = new Date(initial.ttlExpiresAt).getTime() - Date.now();
  const ttlScope = new CancellationScope();
  ttlScope
    .run(async () => {
      if (ttlMs > 0) await sleep(ttlMs);
      if (state.status === "REVIEWING") state.status = "EXPIRED";
    })
    .catch(() => {
      /* cancelled */
    });

  // Active loop
  try {
    while (isActive(state.status)) {
      await condition(() => !isActive(state.status) || state.status === "FINALIZING");

      if (state.status === "FINALIZING") {
        const finalizerResult = await a.runFinalizer({
          setupId: initial.setupId,
          watchId: initial.watchId,
        });
        const decision = JSON.parse(finalizerResult.decisionJson) as {
          go: boolean;
          reasoning: string;
          entry?: number;
          stop_loss?: number;
          take_profit?: number[];
        };
        const seq = (await a.nextSequence({ setupId: initial.setupId })).sequence;
        if (decision.go) {
          state.sequence = seq;
          state.status = "TRACKING";
          everConfirmed = true;
          await a.persistEvent({
            event: {
              setupId: initial.setupId,
              sequence: seq,
              stage: "finalizer",
              actor: "finalizer_v1",
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
              costUsd: finalizerResult.costUsd,
            },
            setupUpdate: {
              score: state.score,
              status: "TRACKING",
              invalidationLevel: state.invalidationLevel,
            },
          });
          await a.notifyTelegramConfirmed({
            watchId: initial.watchId,
            asset: initial.asset,
            timeframe: initial.timeframe,
            direction: initial.direction,
            entry: decision.entry ?? 0,
            stopLoss: decision.stop_loss ?? 0,
            takeProfit: decision.take_profit ?? [],
            reasoning: decision.reasoning,
          });
          await trackingLoop(initial.setupId, initial.watchId);
          // trackingLoop updates DB to CLOSED but not workflow state — sync here
          // so the active loop exits cleanly instead of blocking on `condition`.
          state.status = "CLOSED";
        } else {
          state.sequence = seq;
          state.status = "REJECTED";
          await a.persistEvent({
            event: {
              setupId: initial.setupId,
              sequence: seq,
              stage: "finalizer",
              actor: "finalizer_v1",
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
              costUsd: finalizerResult.costUsd,
            },
            setupUpdate: {
              score: state.score,
              status: "REJECTED",
              invalidationLevel: state.invalidationLevel,
            },
          });
          await a.notifyTelegramRejected({
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

  await a.markSetupClosed({ setupId: initial.setupId, finalStatus: state.status });
  return state.status;
}

export const setupWorkflowId = (id: string) => `setup-${id}`;
