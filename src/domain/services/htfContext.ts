import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Candle } from "@domain/schemas/Candle";

/**
 * Higher-timeframe context for the detector. Captures structural levels and
 * recent daily price action — what the LLM would glance at on a daily chart
 * before zooming into a 15m / 1h tick decision. Independent of the per-tick
 * indicator computation.
 */
export type HtfContext = {
  /** Last 5 daily closes (oldest → newest), with daily H/L. */
  daily5: Array<{ date: string; high: number; low: number; close: number }>;
  /** Highest high / lowest low over the last 7 daily candles. */
  weeklyHigh: number;
  weeklyLow: number;
  /** Highest high / lowest low over the last 30 daily candles. */
  monthlyHigh: number;
  monthlyLow: number;
  /** Position of the live price within the weekly range, 0=at weekly low, 1=at weekly high. */
  positionInWeeklyRange: number;
  /** "uptrend" if last close > 5d ago AND > weeklyLow midpoint; "downtrend" if mirror; else "sideways". */
  dailyTrend: "uptrend" | "downtrend" | "sideways";
};

export async function computeHtfContext(deps: {
  marketDataFetcher: MarketDataFetcher;
  asset: string;
  livePrice: number;
}): Promise<HtfContext> {
  const dailies = await deps.marketDataFetcher.fetchOHLCV({
    asset: deps.asset,
    timeframe: "1d",
    limit: 30,
  });
  return summarizeHtf(dailies, deps.livePrice);
}

/**
 * Pure function exposed for testing and to keep the activity layer thin.
 * Pass exactly the daily candle window (≤30 entries, oldest → newest).
 */
export function summarizeHtf(dailies: Candle[], livePrice: number): HtfContext {
  if (dailies.length === 0) {
    return {
      daily5: [],
      weeklyHigh: livePrice,
      weeklyLow: livePrice,
      monthlyHigh: livePrice,
      monthlyLow: livePrice,
      positionInWeeklyRange: 0.5,
      dailyTrend: "sideways",
    };
  }
  const sorted = [...dailies].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const last5 = sorted.slice(-5);
  const last7 = sorted.slice(-7);
  const last30 = sorted.slice(-30);

  const weeklyHigh = Math.max(...last7.map((c) => c.high));
  const weeklyLow = Math.min(...last7.map((c) => c.low));
  const monthlyHigh = Math.max(...last30.map((c) => c.high));
  const monthlyLow = Math.min(...last30.map((c) => c.low));

  const positionInWeeklyRange =
    weeklyHigh === weeklyLow
      ? 0.5
      : Math.max(0, Math.min(1, (livePrice - weeklyLow) / (weeklyHigh - weeklyLow)));

  // Trend heuristic: compare current livePrice to the close 5 candles back AND
  // its position vs the weekly midpoint. Both must agree.
  const fiveDaysAgoClose = last5[0]?.close ?? livePrice;
  const midpoint = (weeklyHigh + weeklyLow) / 2;
  const above5d = livePrice > fiveDaysAgoClose * 1.005; // ≥+0.5%
  const below5d = livePrice < fiveDaysAgoClose * 0.995;
  const aboveMid = livePrice > midpoint;
  let dailyTrend: HtfContext["dailyTrend"] = "sideways";
  if (above5d && aboveMid) dailyTrend = "uptrend";
  else if (below5d && !aboveMid) dailyTrend = "downtrend";

  return {
    daily5: last5.map((c) => ({
      date: c.timestamp.toISOString().slice(0, 10),
      high: c.high,
      low: c.low,
      close: c.close,
    })),
    weeklyHigh,
    weeklyLow,
    monthlyHigh,
    monthlyLow,
    positionInWeeklyRange,
    dailyTrend,
  };
}
