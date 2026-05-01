import type { Candle } from "@domain/schemas/Candle";
import { detectBosState, detectSwings } from "../base/math";

export type SwingsBosParams = { lookback: number };
export const SWINGS_BOS_DEFAULT_PARAMS: SwingsBosParams = { lookback: 3 };

function readLookback(params?: Record<string, unknown>): number {
  const lb = params?.lookback;
  return typeof lb === "number" ? lb : SWINGS_BOS_DEFAULT_PARAMS.lookback;
}

export function computeScalars(candles: Candle[], params?: Record<string, unknown>) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const swings = detectSwings(highs, lows, readLookback(params));
  const lastIdx = candles.length - 1;
  const lastH = swings.highs[swings.highs.length - 1] ?? null;
  const lastL = swings.lows[swings.lows.length - 1] ?? null;
  return {
    lastSwingHigh: lastH == null ? null : (highs[lastH] ?? null),
    lastSwingHighAge: lastH == null ? null : lastIdx - lastH,
    lastSwingLow: lastL == null ? null : (lows[lastL] ?? null),
    lastSwingLowAge: lastL == null ? null : lastIdx - lastL,
    bosState: detectBosState(highs, lows, closes, swings),
  };
}

export function computeMarkers(candles: Candle[], params?: Record<string, unknown>) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const swings = detectSwings(highs, lows, readLookback(params));
  return {
    swingHighs: swings.highs.map((i) => ({ index: i, price: highs[i] as number })),
    swingLows: swings.lows.map((i) => ({ index: i, price: lows[i] as number })),
  };
}
