import type { Verdict } from "@domain/schemas/Verdict";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type SetupRuntimeState = {
  status: SetupStatus;
  score: number;
  invalidationLevel: number;
  direction: "LONG" | "SHORT";
};

export type ScoringConfig = {
  scoreMax: number;
  scoreThresholdFinalizer: number;
  scoreThresholdDead: number;
};

export function applyVerdict(
  state: SetupRuntimeState,
  verdict: Verdict,
  config: ScoringConfig,
): SetupRuntimeState {
  if (verdict.type === "INVALIDATE") {
    return { ...state, status: "INVALIDATED" };
  }
  if (verdict.type === "NEUTRAL") {
    return { ...state };
  }

  const delta = verdict.scoreDelta;
  const rawScore = state.score + delta;
  const newScore = Math.max(0, Math.min(config.scoreMax, rawScore));
  const newInvalidation =
    verdict.type === "STRENGTHEN" && verdict.invalidationLevelUpdate != null
      ? verdict.invalidationLevelUpdate
      : state.invalidationLevel;

  let newStatus: SetupStatus = state.status;
  if (
    state.status === "REVIEWING" &&
    state.score < config.scoreThresholdFinalizer &&
    newScore >= config.scoreThresholdFinalizer
  ) {
    newStatus = "FINALIZING";
  } else if (newScore <= config.scoreThresholdDead) {
    newStatus = "EXPIRED";
  }

  return {
    ...state,
    score: newScore,
    status: newStatus,
    invalidationLevel: newInvalidation,
  };
}
