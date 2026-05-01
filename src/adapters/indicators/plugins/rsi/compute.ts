import type { Candle } from "@domain/schemas/Candle";
import { rsi as rsiCalc, rsiSeriesAligned } from "../base/math";

export type RsiParams = { period: number };
export const RSI_DEFAULT_PARAMS: RsiParams = { period: 14 };

function readPeriod(params?: Record<string, unknown>): number {
  const p = params?.period;
  return typeof p === "number" ? p : RSI_DEFAULT_PARAMS.period;
}

export function computeRsiScalar(candles: Candle[], params?: Record<string, unknown>): { rsi: number } {
  return { rsi: rsiCalc(candles.map((c) => c.close), readPeriod(params)) };
}

export function computeRsiSeries(candles: Candle[], params?: Record<string, unknown>): (number | null)[] {
  return rsiSeriesAligned(candles.map((c) => c.close), readPeriod(params), candles.length);
}
