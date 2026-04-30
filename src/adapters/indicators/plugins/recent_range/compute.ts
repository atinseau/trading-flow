import type { Candle } from "@domain/schemas/Candle";

export function computeScalars(candles: Candle[]) {
  const tail = candles.slice(-50);
  return {
    recentHigh: Math.max(...tail.map((c) => c.high)),
    recentLow: Math.min(...tail.map((c) => c.low)),
  };
}
