import type { Candle } from "@domain/schemas/Candle";
import { rsi as rsiCalc, rsiSeriesAligned } from "../base/math";

export function computeRsiScalar(candles: Candle[]): { rsi: number } {
  return { rsi: rsiCalc(candles.map((c) => c.close), 14) };
}

export function computeRsiSeries(candles: Candle[]): (number | null)[] {
  return rsiSeriesAligned(candles.map((c) => c.close), 14, candles.length);
}
