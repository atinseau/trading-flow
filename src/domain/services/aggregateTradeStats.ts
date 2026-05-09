/**
 * Pure aggregations over a stream of closed trades. Extracted from the perf
 * API so we can unit-test the math without spinning up a database. The API
 * still owns the SQL / DB layer; it calls these for the equity-curve walk
 * and bucket aggregations.
 */
export type ClosedTrade = {
  rMultiple: number;
  closedAt?: Date | string | null;
  patternHint?: string | null;
  direction?: "LONG" | "SHORT" | null;
};

export type EquityPoint = {
  closedAt: string | null;
  cumulativeR: number;
};

export function buildEquityCurve(trades: ReadonlyArray<ClosedTrade>): {
  equityCurve: EquityPoint[];
  maxDrawdownR: number;
  totalR: number;
} {
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  const equityCurve: EquityPoint[] = [];
  for (const t of trades) {
    cum += t.rMultiple;
    peak = Math.max(peak, cum);
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    const closedAt =
      t.closedAt instanceof Date
        ? t.closedAt.toISOString()
        : typeof t.closedAt === "string"
          ? t.closedAt
          : null;
    equityCurve.push({ closedAt, cumulativeR: round(cum, 4) });
  }
  return { equityCurve, maxDrawdownR: round(maxDD, 4), totalR: round(cum, 4) };
}

export function bucketRMultiples(
  trades: ReadonlyArray<ClosedTrade>,
  bucketSize = 0.5,
): Array<{ bucket: number; count: number }> {
  const buckets = new Map<number, number>();
  for (const t of trades) {
    const b = Math.floor(t.rMultiple / bucketSize) * bucketSize;
    // Round to handle float precision (e.g. 0.5 * 2 might not be exactly 1.0).
    const key = round(b, 4);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => a.bucket - b.bucket);
}

export function summarizeTrades(trades: ReadonlyArray<ClosedTrade>): {
  tradeCount: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  totalR: number;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number;
  avgLoss: number;
} {
  const tradeCount = trades.length;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let totalR = 0;
  let sumPos = 0;
  let sumNeg = 0;
  let countPos = 0;
  let countNeg = 0;
  for (const t of trades) {
    totalR += t.rMultiple;
    if (t.rMultiple > 0) {
      wins += 1;
      sumPos += t.rMultiple;
      countPos += 1;
    } else if (t.rMultiple < 0) {
      losses += 1;
      sumNeg += t.rMultiple;
      countNeg += 1;
    } else {
      breakeven += 1;
    }
  }
  const winRate = wins + losses > 0 ? wins / (wins + losses) : null;
  const sumNegAbs = Math.abs(sumNeg);
  const profitFactor = sumNegAbs > 0 ? sumPos / sumNegAbs : null;
  const expectancy = tradeCount > 0 ? totalR / tradeCount : null;
  return {
    tradeCount,
    wins,
    losses,
    breakeven,
    winRate,
    totalR: round(totalR, 4),
    profitFactor: profitFactor !== null ? round(profitFactor, 4) : null,
    expectancy: expectancy !== null ? round(expectancy, 4) : null,
    avgWin: countPos > 0 ? round(sumPos / countPos, 4) : 0,
    avgLoss: countNeg > 0 ? round(sumNeg / countNeg, 4) : 0,
  };
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
