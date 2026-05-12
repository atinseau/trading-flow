import type { EventPayload } from "@domain/events/schemas";
import type { EventTypeName } from "@domain/events/types";
import type { Verdict } from "@domain/schemas/Verdict";

/**
 * Translates a reviewer `Verdict` (`STRENGTHEN | WEAKEN | NEUTRAL |
 * INVALIDATE`) into the persisted event shape `{ type, payload }`.
 *
 * Single source of truth used by both the live `setupWorkflow` and the
 * replay `processTick`. Previously duplicated verbatim in both places ;
 * keeping them in lockstep through a shared function eliminates the
 * risk of silent drift when a payload field is added.
 */
export function verdictToEvent(
  verdict: Verdict,
): { type: EventTypeName; payload: EventPayload } {
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
