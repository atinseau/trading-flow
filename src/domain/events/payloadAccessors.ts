import type { EventPayload } from "./schemas";

/**
 * Returns the observation list from an event payload, or `[]` for event
 * types that don't carry observations. Used by reviewer prompts to feed
 * the LLM a history of prior verdicts' supporting evidence.
 */
export function extractObservations(payload: EventPayload): unknown[] {
  if (
    payload.type === "Strengthened" ||
    payload.type === "Weakened" ||
    payload.type === "Neutral"
  ) {
    return payload.data.observations;
  }
  return [];
}

/**
 * Returns the LLM-authored reasoning string for verdicts that carry one
 * (Strengthened / Weakened). NEUTRAL doesn't have a reasoning field;
 * other event types are domain events without LLM text.
 */
export function extractReasoning(payload: EventPayload): string | null {
  if (payload.type === "Strengthened" || payload.type === "Weakened") {
    return payload.data.reasoning;
  }
  return null;
}
