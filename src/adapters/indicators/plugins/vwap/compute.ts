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
  return { vwap: vwapSeriesAligned(candles) };
}
