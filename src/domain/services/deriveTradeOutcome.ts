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
  exitPrice: number;
  exitReason: ExitReason;
  metrics: TradeMetrics;
};

/**
 * For terminal setups that reached EntryFilled, extract the trade's prices
 * and compute pnl/r-multiple. Returns null for setups that never had an
 * entry (REJECTED, INVALIDATED_PRE_TRADE, EXPIRED_NO_FILL, ...) or for
 * still-active setups.
 *
 * Exit price priority:
 *   1. Last SLHit  → exit at SL level, exitReason=SL_HIT
 *   2. Last TPHit  → exit at last hit TP level, exitReason=TP_HIT
 *      (PARTIAL_WIN handled by deriveOutcome upstream; for the price we
 *       take the last TP touched. If both SL and TP hit, SL wins price-wise
 *       since trailing-to-breakeven means a "stopped at BE after TP1" reads
 *       as exit=entry, r=0 — desirable.)
 *   3. Invalidated → exit at priceAtInvalidation if present, else null
 *   4. Expired     → exit at last known price unavailable here → null
 *   5. Killed      → null (can't infer fill)
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

  const entryFilled = args.events.find((e) => e.type === "EntryFilled");
  if (!entryFilled) return null;

  const slHits = args.events.filter((e) => e.type === "SLHit");
  const tpHits = args.events.filter((e) => e.type === "TPHit");
  const invalidatedPostTrade = args.events.find((e) => e.type === "Invalidated");
  const expired = args.events.find((e) => e.type === "Expired");

  let exitPrice: number | null = null;
  let exitReason: ExitReason | null = null;

  if (slHits.length > 0) {
    const last = slHits[slHits.length - 1];
    if (last?.payload?.type === "SLHit") {
      exitPrice = last.payload.data.level;
      exitReason = "SL_HIT";
    }
  } else if (tpHits.length > 0) {
    const last = tpHits[tpHits.length - 1];
    if (last?.payload?.type === "TPHit") {
      exitPrice = last.payload.data.level;
      exitReason = "TP_HIT";
    }
  } else if (invalidatedPostTrade?.payload?.type === "Invalidated") {
    exitPrice = invalidatedPostTrade.payload.data.priceAtInvalidation ?? null;
    exitReason = "INVALIDATED";
  } else if (expired) {
    // Expired without hitting TP/SL → can't compute pnl reliably.
    exitReason = "TTL_EXPIRED";
  }

  if (exitPrice === null || exitReason === null) return null;

  return {
    entryPrice,
    stopLoss,
    exitPrice,
    exitReason,
    metrics: computeTradeMetrics({
      direction: args.direction,
      entryPrice,
      stopLoss,
      exitPrice,
    }),
  };
}
