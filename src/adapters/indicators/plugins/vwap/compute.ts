import type { Candle } from "@domain/schemas/Candle";
import { vwapSeriesAligned } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const series = vwapSeriesAligned(candles);
  const vwap = series[series.length - 1] ?? candles[candles.length - 1]?.close ?? 0;
  const lastClose = candles[candles.length - 1]?.close ?? 0;
  const priceVsVwapPct = vwap === 0 ? 0 : ((lastClose - vwap) / vwap) * 100;
  return { vwapSession: vwap, priceVsVwapPct };
}

export function computeSeries(candles: Candle[]) {
  const raw = vwapSeriesAligned(candles);
  // Gap the line at each session boundary to avoid horizontal jumps.
  const gapped: (number | null)[] = raw.map((v, i) => {
    if (i === 0) return v;
    const cur = candles[i];
    const prev = candles[i - 1];
    if (!cur || !prev) return v;
    const curDay = Math.floor(cur.timestamp.getTime() / 86_400_000);
    const prevDay = Math.floor(prev.timestamp.getTime() / 86_400_000);
    return curDay !== prevDay ? null : v;
  });
  return { vwap: gapped };
}
