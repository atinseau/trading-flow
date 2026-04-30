import type { Candle } from "@domain/schemas/Candle";
import { bollingerLast, bollingerSeriesAligned, percentileOf } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const bb = bollingerLast(closes, 20, 2);
  const series = bollingerSeriesAligned(closes, 20, 2);
  const widths: number[] = [];
  for (let i = 0; i < series.middle.length; i++) {
    const m = series.middle[i], u = series.upper[i], l = series.lower[i];
    if (m == null || u == null || l == null || m === 0) continue;
    widths.push(((u - l) / m) * 100);
  }
  const bandwidth = bb.middle === 0 ? 0 : ((bb.upper - bb.lower) / bb.middle) * 100;
  return {
    bbUpper: bb.upper, bbMiddle: bb.middle, bbLower: bb.lower,
    bbBandwidthPct: bandwidth,
    bbBandwidthPercentile200: percentileOf(bandwidth, widths.slice(-201, -1)),
  };
}
export function computeSeries(candles: Candle[]) {
  return bollingerSeriesAligned(candles.map((c) => c.close), 20, 2);
}
