import type { PriceInvalidatedPayload } from "@domain/events/schemas";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import type { z } from "zod";

export type SetupRuntimeState = {
  status: SetupStatus;
  score: number;
  invalidationLevel: number;
  direction: "LONG" | "SHORT";
};

export type PriceInvalidationEventInput = {
  state: SetupRuntimeState;
  currentPrice: number;
  observedAt: string;
  /** "price_monitor" for live's REVIEWING/FINALIZING priceCheckSignal,
   *  "tracker" for the intra-candle simulator (replay) or trackingLoop (live). */
  trigger: "price_monitor" | "tracker";
};

export type PriceInvalidationEvent = {
  stage: "system";
  actor: "price_monitor" | "tracker";
  type: "PriceInvalidated";
  scoreDelta: 0;
  scoreAfter: number;
  statusBefore: SetupStatus;
  statusAfter: "INVALIDATED";
  payload: { type: "PriceInvalidated"; data: z.infer<typeof PriceInvalidatedPayload> };
};

/**
 * Canonical builder for the `PriceInvalidated` event. Used by:
 * - Live: `setupWorkflow.priceCheckSignal` (REVIEWING/FINALIZING) and `trackingLoop` (TRACKING).
 * - Replay: `processTick` tracker-time invalidation (replaces "Invalidated" type — Drift C fix).
 */
export function buildPriceInvalidationEvent(
  input: PriceInvalidationEventInput,
): PriceInvalidationEvent {
  return {
    stage: "system",
    actor: input.trigger,
    type: "PriceInvalidated",
    scoreDelta: 0,
    scoreAfter: input.state.score,
    statusBefore: input.state.status,
    statusAfter: "INVALIDATED",
    payload: {
      type: "PriceInvalidated",
      data: {
        currentPrice: input.currentPrice,
        invalidationLevel: input.state.invalidationLevel,
        observedAt: input.observedAt,
      },
    },
  };
}
