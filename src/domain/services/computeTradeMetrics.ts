/**
 * Pure trade-metrics arithmetic. Used by the poller when persisting a
 * terminal setup's perf row, and by tests directly.
 *
 * R-multiple = signed move / risk. R = +1 means hit a target equal to one
 * risk unit (1R win); R = −1 means hit the original SL exactly.
 *
 * Risk is always |entry − stopLoss|. If stopLoss equals entry (degenerate
 * config), we return rMultiple = 0 to avoid division-by-zero rather than
 * propagate Infinity into aggregates.
 */
export type Direction = "LONG" | "SHORT";

export type TradeMetrics = {
  pnlPct: number;
  rMultiple: number;
};

export function computeTradeMetrics(args: {
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  exitPrice: number;
}): TradeMetrics {
  const sign = args.direction === "LONG" ? 1 : -1;
  const moveAbs = (args.exitPrice - args.entryPrice) * sign;
  const pnlPct = args.entryPrice !== 0 ? (moveAbs / args.entryPrice) * 100 : 0;
  const riskAbs = Math.abs(args.entryPrice - args.stopLoss);
  const rMultiple = riskAbs > 0 ? moveAbs / riskAbs : 0;
  return { pnlPct, rMultiple };
}
