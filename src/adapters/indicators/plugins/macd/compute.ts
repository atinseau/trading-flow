import type { Candle } from "@domain/schemas/Candle";
import { macdSeriesAligned } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const series = macdSeriesAligned(closes, 12, 26, 9);
  const last = (a: (number | null)[]) => a[a.length - 1] ?? 0;
  return { macd: last(series.macd), macdSignal: last(series.signal), macdHist: last(series.hist) };
}
export function computeSeries(candles: Candle[]) {
  return macdSeriesAligned(candles.map((c) => c.close), 12, 26, 9);
}
