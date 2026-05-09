import type { EventPayload } from "@domain/events/schemas";
import {
  computeTradeMetrics,
  type Direction,
  type TradeMetrics,
} from "@domain/services/computeTradeMetrics";

export type ExitReason = "TP_HIT" | "SL_HIT" | "TTL_EXPIRED" | "INVALIDATED" | "KILLED";

export type EventWithPayload = {
  type: string;
  sequence: number;
  payload: EventPayload | null;
};

export type TradeOutcome = {
  entryPrice: number;
  stopLoss: number;
  /**
   * Price at the FINAL exit event (informational; what the bot's tracker
   * recorded as the closing event). Use `metrics.rMultiple` for the
   * weighted-aggregate R, not raw entry/exit math — they diverge when there
   * are multiple TPs (partial fills).
   */
  exitPrice: number;
  exitReason: ExitReason;
  metrics: TradeMetrics;
};

/**
 * For terminal setups that reached EntryFilled, derive trade R-multiple
 * with **equal-weight partial fills across N take-profits**. Models a
 * trader who scales out 1/N of the position at each TP, with the final
 * exit (last TP or trailed SL) closing the remaining size.
 *
 * Why partials matter: the tracker emits TPHit events as price visits each
 * TP, then trails SL to breakeven after TP1. With a 2-TP setup that hit
 * TP1 then bounced back to BE, an "all-in / all-out at last event" model
 * would record 0R — but a real trader who took 50% at TP1 and 50% at BE
 * actually made +0.5R. Equal-weight partials matches that reality.
 *
 * Returns null for setups that never had an entry (REJECTED,
 * INVALIDATED_PRE_TRADE, EXPIRED_NO_FILL, ...) or for cases where we have
 * no exit price information (TTL expiry without TP/SL — handled upstream
 * with a 0R conservative default).
 */
export function deriveTradeOutcome(args: {
  direction: Direction | null;
  events: ReadonlyArray<EventWithPayload>;
}): TradeOutcome | null {
  if (!args.direction) return null;

  const confirmed = args.events.find((e) => e.type === "Confirmed");
  if (!confirmed?.payload || confirmed.payload.type !== "Confirmed") return null;
  const entryPrice = confirmed.payload.data.entry;
  const stopLoss = confirmed.payload.data.stopLoss;
  const targetCount = confirmed.payload.data.takeProfit.length;
  // Defensive: targetCount must be ≥ 1 (zod schema enforces .min(1)).
  const tpWeight = 1 / Math.max(targetCount, 1);

  const entryFilled = args.events.find((e) => e.type === "EntryFilled");
  if (!entryFilled) return null;

  const tpHits = args.events.filter((e) => e.type === "TPHit" && e.payload?.type === "TPHit");
  const slHits = args.events.filter((e) => e.type === "SLHit" && e.payload?.type === "SLHit");
  const invalidated = args.events.find(
    (e) => e.type === "Invalidated" && e.payload?.type === "Invalidated",
  );
  const expired = args.events.find((e) => e.type === "Expired");

  // Aggregate R: each TPHit contributes tpWeight × R(at that TP). Final
  // exit (SL/Invalidated/last-TP) covers the remaining unsold weight.
  let aggregatedR = 0;
  let aggregatedPnlPct = 0;
  let unsoldWeight = 1;

  for (const tp of tpHits) {
    if (tp.payload?.type !== "TPHit") continue;
    const tpLevel = tp.payload.data.level;
    const isFinal =
      // Last TP in the array of TP events AND no later SL → final exit;
      // we'll handle final-exit weighting below using unsoldWeight.
      tp === tpHits[tpHits.length - 1] &&
      slHits.length === 0 &&
      tp.payload.data.index === targetCount - 1;
    if (isFinal) continue; // handled in final-exit block below
    const m = computeTradeMetrics({
      direction: args.direction,
      entryPrice,
      stopLoss,
      exitPrice: tpLevel,
    });
    aggregatedR += tpWeight * m.rMultiple;
    aggregatedPnlPct += tpWeight * m.pnlPct;
    unsoldWeight -= tpWeight;
  }

  // Final exit: SL (post-trail), Invalidated, last-TP, or unresolved.
  let finalExitPrice: number | null = null;
  let exitReason: ExitReason | null = null;

  if (slHits.length > 0) {
    const last = slHits[slHits.length - 1];
    if (last?.payload?.type === "SLHit") {
      finalExitPrice = last.payload.data.level;
      exitReason = "SL_HIT";
    }
  } else if (tpHits.length > 0) {
    // Final TP only counts as the closing event if its index reaches the
    // last configured TP. Otherwise the trade closed via Expired /
    // Invalidated AFTER a partial TP — those branches own the final exit.
    const last = tpHits[tpHits.length - 1];
    if (last?.payload?.type === "TPHit" && last.payload.data.index === targetCount - 1) {
      finalExitPrice = last.payload.data.level;
      exitReason = "TP_HIT";
    } else if (invalidated?.payload?.type === "Invalidated") {
      finalExitPrice = invalidated.payload.data.priceAtInvalidation ?? null;
      exitReason = "INVALIDATED";
    } else if (expired) {
      exitReason = "TTL_EXPIRED";
    }
  } else if (invalidated?.payload?.type === "Invalidated") {
    finalExitPrice = invalidated.payload.data.priceAtInvalidation ?? null;
    exitReason = "INVALIDATED";
  } else if (expired) {
    exitReason = "TTL_EXPIRED";
    // No price → handled by TIME_OUT zero-R fallback in the poller.
  }

  // TTL_EXPIRED with no TP/SL hit: no exit price available, but we still
  // record the trade with a conservative 0R for the unsold portion. Without
  // this, expired trades would vanish from equity curve / R-distribution
  // / calibration — yet they did happen and their absence skews aggregates
  // toward false optimism (only winning + losing trades shown).
  if (exitReason === "TTL_EXPIRED" && finalExitPrice === null) {
    return {
      entryPrice,
      stopLoss,
      // Convention: unknown exit → record entry price (yields 0R for the
      // unsold portion). The aggregated R already includes any partial TPs.
      exitPrice: entryPrice,
      exitReason,
      metrics: {
        pnlPct: aggregatedPnlPct,
        rMultiple: aggregatedR,
      },
    };
  }

  if (finalExitPrice === null || exitReason === null) return null;

  // Apply final exit at remaining weight.
  const finalM = computeTradeMetrics({
    direction: args.direction,
    entryPrice,
    stopLoss,
    exitPrice: finalExitPrice,
  });
  aggregatedR += unsoldWeight * finalM.rMultiple;
  aggregatedPnlPct += unsoldWeight * finalM.pnlPct;

  return {
    entryPrice,
    stopLoss,
    exitPrice: finalExitPrice,
    exitReason,
    metrics: {
      pnlPct: aggregatedPnlPct,
      rMultiple: aggregatedR,
    },
  };
}
