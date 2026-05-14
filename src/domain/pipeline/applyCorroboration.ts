import type { StrengthenedPayload, WeakenedPayload } from "@domain/events/schemas";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import type { z } from "zod";

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

export type CorroborationInput = {
  state: SetupRuntimeState;
  /** Signed delta, `[-20, 20]` per `DetectorOutput.confidence_delta_suggested`. */
  delta: number;
  scoring: ScoringConfig;
  detectorPromptVersion: string;
};

export type CorroborationResult =
  | { kind: "noop" }
  | { kind: "ignored" }
  | {
      kind: "applied";
      next: SetupRuntimeState;
      event: {
        stage: "detector";
        actor: string;
        type: "Strengthened" | "Weakened";
        scoreDelta: number;
        scoreAfter: number;
        statusBefore: SetupStatus;
        statusAfter: SetupStatus;
        payload:
          | { type: "Strengthened"; data: z.infer<typeof StrengthenedPayload> }
          | { type: "Weakened"; data: z.infer<typeof WeakenedPayload> };
      };
    };

const STRENGTHENED_REASONING = "Corroborating evidence from detector";
const WEAKENED_REASONING = "Detector observes pattern weakening or no longer visible on chart";

/**
 * Apply a detector corroboration signal to an alive setup.
 *
 * Shared by `setupWorkflow.corroborateSignal` (live) and `processTick.ts`
 * phase 2a (replay). Drift A from the 2026-05-14 audit : replay used to
 * destructure only `new_setups` from the detector verdict and silently
 * drop `corroborations[]`, leaving score trajectories divergent from live
 * the moment the detector emitted a corroboration. With this helper,
 * both pipelines run the same scoring + state transitions.
 *
 * Semantics :
 * - `delta === 0`                  → noop (caller doesn't persist).
 * - `state.status !== "REVIEWING"` → ignored.
 * - `newScore = clamp(score + delta, [0, scoreMax])` (floor + ceiling).
 * - `delta > 0`                    → `Strengthened` event,
 *   `payload.data.source = "detector_corroboration"`.
 * - `delta < 0`                    → `Weakened` event,
 *   `payload.data.source = "detector_decorroboration"`.
 * - `newScore >= threshold`        → `statusAfter = "FINALIZING"`.
 * - `newScore <= dead`             → `statusAfter = "EXPIRED"`.
 */
export function applyCorroboration(input: CorroborationInput): CorroborationResult {
  if (input.delta === 0) return { kind: "noop" };
  if (input.state.status !== "REVIEWING") return { kind: "ignored" };

  const rawScore = input.state.score + input.delta;
  const newScore = Math.max(0, Math.min(input.scoring.scoreMax, rawScore));
  const actualDelta = newScore - input.state.score;

  let newStatus: SetupStatus = "REVIEWING";
  if (newScore >= input.scoring.scoreThresholdFinalizer) {
    newStatus = "FINALIZING";
  } else if (newScore <= input.scoring.scoreThresholdDead) {
    newStatus = "EXPIRED";
  }

  const next: SetupRuntimeState = {
    status: newStatus,
    score: newScore,
    invalidationLevel: input.state.invalidationLevel,
    direction: input.state.direction,
  };

  const isStrengthen = input.delta > 0;

  return {
    kind: "applied",
    next,
    event: {
      stage: "detector",
      actor: input.detectorPromptVersion,
      type: isStrengthen ? "Strengthened" : "Weakened",
      scoreDelta: actualDelta,
      scoreAfter: newScore,
      statusBefore: input.state.status,
      statusAfter: newStatus,
      payload: isStrengthen
        ? {
            type: "Strengthened",
            data: {
              reasoning: STRENGTHENED_REASONING,
              observations: [],
              source: "detector_corroboration",
            },
          }
        : {
            type: "Weakened",
            data: {
              reasoning: WEAKENED_REASONING,
              observations: [],
              source: "detector_decorroboration",
            },
          },
    },
  };
}
