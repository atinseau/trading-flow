import type { Candle } from "@domain/schemas/Candle";

/**
 * Mutable state for a single setup being tracked through the replay window.
 * Lives only in the workflow's in-memory `alive` map ; persisted state lives
 * in `replay_events`.
 */
export type TrackingState = {
  direction: "LONG" | "SHORT";
  entry: number;
  currentSL: number;
  /**
   * Structural-break level distinct from `currentSL`. If price crosses it
   * BEFORE the SL it represents a thesis invalidation (different failure
   * mode for the feedback loop : `price_invalidated` vs `sl_hit_*`).
   * Live tracks it via `invalidationLevel` on the setup ; here it is the
   * level captured at SetupCreated time and never trails.
   */
  invalidationLevel: number;
  /** Sorted in price-traversal order : ascending for LONG, descending for SHORT. */
  sortedTPs: number[];
  nextTpIndex: number;
  /** True once the limit-entry was hit. EntryFilled fires exactly once. */
  entryFilled: boolean;
  /** Set when the simulation closes the setup (SL hit, all TPs hit, invalidated). */
  closed: boolean;
  /** Set when SL fires after at least one TP — used to label the close reason
   *  for the feedback loop ("sl_hit_after_tp1" vs "sl_hit_direct"). */
  slHitAfterTp1: boolean;
  /** Set when the structural invalidation level fires before any SL/TP. */
  priceInvalidated: boolean;
};

export type TrackerEvent =
  | { kind: "EntryFilled"; fillPrice: number; observedAt: Date }
  | {
      kind: "TPHit";
      level: number;
      index: number;
      isFinal: boolean;
      observedAt: Date;
    }
  | { kind: "SLHit"; level: number; observedAt: Date }
  | {
      kind: "PriceInvalidated";
      currentPrice: number;
      invalidationLevel: number;
      observedAt: Date;
    }
  | { kind: "TrailingMoved"; newStopLoss: number; reason: string };

/**
 * Outcome semantics expected by the feedback loop when the setup closes
 * via tracking. Mirrors the live `TrackingResult.reason` enum (see
 * `domain/feedback/closeOutcome.ts`).
 */
export type CloseTrackingReason =
  | "sl_hit_direct"
  | "sl_hit_after_tp1"
  | "all_tps_hit"
  | "price_invalidated";

/**
 * Constructs the initial `TrackingState` for a setup that just transitioned
 * to TRACKING. `takeProfit` is sorted in price-traversal order so
 * `sortedTPs[0]` is always "first to hit". `invalidationLevel` defaults
 * to `stopLoss` when not provided — preserves backward compat with
 * setups that don't declare a structural break separately.
 */
export function initialTrackingState(args: {
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number[];
  invalidationLevel?: number;
}): TrackingState {
  const sortedTPs =
    args.direction === "LONG"
      ? [...args.takeProfit].sort((x, y) => x - y)
      : [...args.takeProfit].sort((x, y) => y - x);
  return {
    direction: args.direction,
    entry: args.entry,
    currentSL: args.stopLoss,
    invalidationLevel: args.invalidationLevel ?? args.stopLoss,
    sortedTPs,
    nextTpIndex: 0,
    entryFilled: false,
    closed: false,
    slHitAfterTp1: false,
    priceInvalidated: false,
  };
}

/**
 * Simulates one candle of tracking against a setup's state. Mutates the
 * passed-in state and returns the ordered list of events the candle
 * produced. Convention :
 *
 * - **SL prioritaire intra-bougie** (spec §10 invariant 10) : when a single
 *   candle's range spans both the SL and the next TP, the SL wins. We
 *   can't infer order from H/L/O/C alone, so the conservative choice is
 *   to assume the adverse move came first. Live tick-by-tick tracking
 *   resolves this naturally ; replay can only emulate.
 *
 * - **EntryFilled fires on the first candle whose range touches `entry`**
 *   (only relevant before `entryFilled` is true). Subsequent SL/TP checks
 *   on the SAME candle still fire — the entry could fill and the stop
 *   could hit in the same candle, conservative-side.
 *
 * - **Sequential TPs** : only `sortedTPs[nextTpIndex]` is eligible to hit
 *   per candle. Multiple TPs in one candle still fire one-at-a-time so
 *   the event order is faithful to live behavior.
 *
 * - **Move SL to breakeven on TP1** : after `nextTpIndex` increments past
 *   zero (i.e. TP1 just hit), `currentSL` is set to `entry`.
 *
 * - **Close** when `nextTpIndex` reaches `sortedTPs.length` OR when SL
 *   hits. Subsequent simulate calls are no-ops.
 */
export function simulateCandleTracking(
  state: TrackingState,
  candle: Candle,
): TrackerEvent[] {
  if (state.closed) return [];
  const events: TrackerEvent[] = [];

  // 1. Entry fill check (only if not yet filled).
  if (!state.entryFilled) {
    const entryTouched =
      candle.low <= state.entry && candle.high >= state.entry;
    if (entryTouched) {
      state.entryFilled = true;
      events.push({ kind: "EntryFilled", fillPrice: state.entry, observedAt: candle.timestamp });
    } else {
      // No fill on this candle — SL/TP checks are irrelevant.
      return events;
    }
  }

  // 2. PriceInvalidated check (structural break) — fires BEFORE the SL
  //    check if the invalidation level is more permissive than the SL.
  //    Live's `trackingLoop` checks it first ; we mirror that for parity.
  //    Only relevant when `invalidationLevel !== currentSL` (otherwise SL
  //    has already absorbed it).
  if (state.invalidationLevel !== state.currentSL) {
    const invalidated =
      state.direction === "LONG"
        ? candle.low <= state.invalidationLevel
        : candle.high >= state.invalidationLevel;
    if (invalidated) {
      events.push({
        kind: "PriceInvalidated",
        currentPrice: state.invalidationLevel,
        invalidationLevel: state.invalidationLevel,
        observedAt: candle.timestamp,
      });
      state.closed = true;
      state.priceInvalidated = true;
      return events;
    }
  }

  // 3. SL prioritaire intra-bougie. For LONG, SL is below entry (candle.low
  //    must reach down to or below SL). For SHORT, SL is above entry
  //    (candle.high must reach up to or above SL).
  const slHit =
    state.direction === "LONG"
      ? candle.low <= state.currentSL
      : candle.high >= state.currentSL;
  if (slHit) {
    events.push({ kind: "SLHit", level: state.currentSL, observedAt: candle.timestamp });
    state.closed = true;
    state.slHitAfterTp1 = state.nextTpIndex > 0;
    return events;
  }

  // 4. Sequential TP checks. A candle's range can span multiple TPs in
  //    theory ; we fire them in order and break out of the close check.
  while (state.nextTpIndex < state.sortedTPs.length) {
    const tp = state.sortedTPs[state.nextTpIndex];
    if (tp === undefined) break;
    const tpHit =
      state.direction === "LONG" ? candle.high >= tp : candle.low <= tp;
    if (!tpHit) break;
    const isFinal = state.nextTpIndex === state.sortedTPs.length - 1;
    events.push({
      kind: "TPHit",
      level: tp,
      index: state.nextTpIndex,
      isFinal,
      observedAt: candle.timestamp,
    });
    state.nextTpIndex += 1;
    // Move SL to breakeven on TP1.
    if (state.nextTpIndex === 1 && state.currentSL !== state.entry) {
      state.currentSL = state.entry;
      events.push({
        kind: "TrailingMoved",
        newStopLoss: state.entry,
        reason: "tp1_hit_move_to_breakeven",
      });
    }
    if (isFinal) {
      state.closed = true;
      break;
    }
  }

  return events;
}

/**
 * Returns the close reason once the simulation has closed the setup.
 * Returns null otherwise. Used by the workflow to feed
 * `runFeedbackAnalysisReplay`.
 */
export function closeReasonFromState(state: TrackingState): CloseTrackingReason | null {
  if (!state.closed) return null;
  if (state.priceInvalidated) return "price_invalidated";
  if (state.nextTpIndex >= state.sortedTPs.length) return "all_tps_hit";
  // Closed but not all TPs hit and not invalidated → must be a SL.
  return state.slHitAfterTp1 ? "sl_hit_after_tp1" : "sl_hit_direct";
}
