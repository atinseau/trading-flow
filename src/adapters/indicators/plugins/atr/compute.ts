import type { Candle } from "@domain/schemas/Candle";
import { atrSeries, movingAverage, rollingMaAligned, zScoreOfLast } from "../base/math";

export type AtrParams = { period: number };
export const ATR_DEFAULT_PARAMS: AtrParams = { period: 14 };

function readPeriod(params?: Record<string, unknown>): number {
  const p = params?.period;
  return typeof p === "number" ? p : ATR_DEFAULT_PARAMS.period;
}

export function computeScalars(candles: Candle[], params?: Record<string, unknown>) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const series = atrSeries(highs, lows, closes, readPeriod(params));
  const atr = series[series.length - 1] ?? 0;
  return {
    atr, atrMa20: movingAverage(series, 20), atrZScore200: zScoreOfLast(series, 200),
  };
}
export function computeSeries(candles: Candle[], params?: Record<string, unknown>) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const core = atrSeries(highs, lows, closes, readPeriod(params));
  const padLen = candles.length - core.length;
  const atr: (number | null)[] = [
    ...Array.from({ length: padLen }, () => null), ...core,
  ];
  const atrMa20 = rollingMaAligned(atr, 20);
  return { atr, atrMa20 };
}
