import {
  buildPriceInvalidationEvent,
  type PriceInvalidationEvent,
  type SetupRuntimeState,
} from "./priceInvalidationEvent";

export type PriceCheckInput = {
  state: SetupRuntimeState;
  currentPrice: number;
  observedAt: string;
};

export type PriceCheckResult =
  | { kind: "not_breached" }
  | { kind: "not_active" }
  | {
      kind: "applied";
      next: SetupRuntimeState;
      event: PriceInvalidationEvent;
    };

/**
 * Apply a REVIEWING/FINALIZING-phase price-breach check.
 *
 * Live uses this in `setupWorkflow.priceCheckSignal`. Replay uses it in
 * a new phase 0.5 of `processTick.ts` — Drift D fix : replay previously
 * had no REVIEWING-time price-breach check, so setups whose price moved
 * through the invalidation level between detector ticks were never
 * invalidated by replay (only via TTL).
 *
 * TRACKING-phase invalidation is handled separately by `trackingLoop`
 * (live) / `simulateCandleTracking` (replay) which simulate intra-candle
 * prices against SL/TP. This helper returns `not_active` for TRACKING
 * to surface the channel split explicitly.
 *
 * Breach condition is strict :
 * - LONG  breaches when `price < invalidationLevel`
 * - SHORT breaches when `price > invalidationLevel`
 *   (equal to the level is NOT a breach — mirrors live behavior.)
 */
export function applyPriceCheck(input: PriceCheckInput): PriceCheckResult {
  if (input.state.status === "TRACKING") return { kind: "not_active" };
  if (input.state.status !== "REVIEWING" && input.state.status !== "FINALIZING") {
    return { kind: "not_active" };
  }

  const breached =
    (input.state.direction === "LONG" && input.currentPrice < input.state.invalidationLevel) ||
    (input.state.direction === "SHORT" && input.currentPrice > input.state.invalidationLevel);
  if (!breached) return { kind: "not_breached" };

  const event = buildPriceInvalidationEvent({
    state: input.state,
    currentPrice: input.currentPrice,
    observedAt: input.observedAt,
    trigger: "price_monitor",
  });

  return {
    kind: "applied",
    next: { ...input.state, status: "INVALIDATED" },
    event,
  };
}
