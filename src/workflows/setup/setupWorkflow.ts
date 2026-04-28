import {
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
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

export async function setupWorkflow(initial: InitialEvidence): Promise<SetupStatus> {
  const state: SetupWorkflowState = {
    status: "REVIEWING",
    score: initial.initialScore,
    invalidationLevel: initial.invalidationLevel,
    direction: initial.direction,
    sequence: 0,
  };

  // Register handlers before any await so signals/queries received during
  // workflow startup are not dropped.
  setHandler(getStateQuery, () => state);

  setHandler(reviewSignal, async (args) => {
    if (state.status !== "REVIEWING") return;
    const { verdictJson } = await a.runReviewer({
      setupId: initial.setupId,
      tickSnapshotId: args.tickSnapshotId,
      watchId: initial.watchId,
    });
    const v = JSON.parse(verdictJson).verdict as { type: string; scoreDelta?: number };
    if (v.type === "INVALIDATE") {
      state.status = "INVALIDATED";
      return;
    }
    if (v.type === "STRENGTHEN" || v.type === "WEAKEN") {
      const delta = v.scoreDelta ?? 0;
      state.score = Math.max(0, Math.min(initial.scoreMax, state.score + delta));
      if (state.score <= initial.scoreThresholdDead) state.status = "EXPIRED";
      else if (state.score >= initial.scoreThresholdFinalizer) state.status = "FINALIZING";
    }
  });

  setHandler(corroborateSignal, async (args) => {
    if (state.status !== "REVIEWING") return;
    state.score = Math.min(initial.scoreMax, state.score + args.confidenceDelta);
    if (state.score >= initial.scoreThresholdFinalizer) state.status = "FINALIZING";
  });

  setHandler(priceCheckSignal, (args) => {
    const breached =
      (state.direction === "LONG" && args.currentPrice < state.invalidationLevel) ||
      (state.direction === "SHORT" && args.currentPrice > state.invalidationLevel);
    if (breached) state.status = "INVALIDATED";
  });

  setHandler(closeSignal, () => {
    state.status = "CLOSED";
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
        const { decisionJson } = await a.runFinalizer({
          setupId: initial.setupId,
          watchId: initial.watchId,
        });
        const decision = JSON.parse(decisionJson) as { go: boolean; reasoning: string };
        if (decision.go) {
          state.status = "TRACKING";
          await trackingLoop(initial.setupId, initial.watchId);
        } else {
          state.status = "REJECTED";
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
