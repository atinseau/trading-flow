import type { Candle } from "@domain/schemas/Candle";
import { atrSeries, movingAverage, rollingMaAligned, zScoreOfLast } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const series = atrSeries(highs, lows, closes, 14);
  const atr = series[series.length - 1] ?? 0;
  return {
    atr, atrMa20: movingAverage(series, 20), atrZScore200: zScoreOfLast(series, 200),
  };
}
export function computeSeries(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const core = atrSeries(highs, lows, closes, 14);
  const padLen = candles.length - core.length;
  const atr: (number | null)[] = [
    ...Array.from({ length: padLen }, () => null), ...core,
  ];
  const atrMa20 = rollingMaAligned(atr, 20);
  return { atr, atrMa20 };
}
