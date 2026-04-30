import type { Candle } from "@domain/schemas/Candle";
import { ema, emaSeriesAligned } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  return { ema20: ema(closes, 20), ema50: ema(closes, 50), ema200: ema(closes, 200) };
}
export function computeSeries(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const n = candles.length;
  return {
    ema20: emaSeriesAligned(closes, 20, n),
    ema50: emaSeriesAligned(closes, 50, n),
    ema200: emaSeriesAligned(closes, 200, n),
  };
}
