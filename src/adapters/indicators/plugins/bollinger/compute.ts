import type { Candle } from "@domain/schemas/Candle";
import { bollingerLast, bollingerSeriesAligned, percentileOf } from "../base/math";

export type BollingerParams = { period: number; std_mul: number };
export const BOLLINGER_DEFAULT_PARAMS: BollingerParams = { period: 20, std_mul: 2 };

function readParams(params?: Record<string, unknown>): BollingerParams {
  const period = params?.period;
  const std_mul = params?.std_mul;
  return {
    period: typeof period === "number" ? period : BOLLINGER_DEFAULT_PARAMS.period,
    std_mul: typeof std_mul === "number" ? std_mul : BOLLINGER_DEFAULT_PARAMS.std_mul,
  };
}

export function computeScalars(candles: Candle[], params?: Record<string, unknown>) {
  const closes = candles.map((c) => c.close);
  const { period, std_mul } = readParams(params);
  const bb = bollingerLast(closes, period, std_mul);
  const series = bollingerSeriesAligned(closes, period, std_mul);
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
export function computeSeries(candles: Candle[], params?: Record<string, unknown>) {
  const { period, std_mul } = readParams(params);
  return bollingerSeriesAligned(candles.map((c) => c.close), period, std_mul);
}
