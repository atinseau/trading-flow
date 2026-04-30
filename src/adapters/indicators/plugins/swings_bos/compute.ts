import type { Candle } from "@domain/schemas/Candle";
import { detectBosState, detectSwings } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const swings = detectSwings(highs, lows, 2);
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

export function computeMarkers(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const swings = detectSwings(highs, lows, 2);
  return {
    swingHighs: swings.highs.map((i) => ({ index: i, price: highs[i] as number })),
    swingLows: swings.lows.map((i) => ({ index: i, price: lows[i] as number })),
  };
}
