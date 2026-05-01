import type { Candle } from "@domain/schemas/Candle";
import { detectSwings, equalPivots } from "../base/math";

const TOLERANCE = 0.001;
const RECENT = 50;

export function computeScalars(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const swings = detectSwings(highs, lows, 2);
  const recentH = equalPivots(
    swings.highs.filter((i) => i >= candles.length - RECENT), highs, TOLERANCE,
  );
  const recentL = equalPivots(
    swings.lows.filter((i) => i >= candles.length - RECENT), lows, TOLERANCE,
  );
  return {
    equalHighsCount: recentH.reduce((a, b) => a + b.indices.length, 0),
    equalLowsCount: recentL.reduce((a, b) => a + b.indices.length, 0),
    topEqualHighs: recentH
      .map((g) => ({ price: g.price, touches: g.indices.length }))
      .sort((a, b) => b.touches - a.touches).slice(0, 3),
    topEqualLows: recentL
      .map((g) => ({ price: g.price, touches: g.indices.length }))
      .sort((a, b) => b.touches - a.touches).slice(0, 3),
  };
}

export function computePriceLines(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const swings = detectSwings(highs, lows, 2);
  const eh = equalPivots(swings.highs, highs, TOLERANCE).slice(-5);
  const el = equalPivots(swings.lows, lows, TOLERANCE).slice(-5);
  return [
    ...eh.map((e) => ({ price: e.price, color: "rgba(255,235,59,0.6)" as const, style: 1 as const, title: `EQH×${e.indices.length}` })),
    ...el.map((e) => ({ price: e.price, color: "rgba(255,235,59,0.6)" as const, style: 1 as const, title: `EQL×${e.indices.length}` })),
  ];
}
