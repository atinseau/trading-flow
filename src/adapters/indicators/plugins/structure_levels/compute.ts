import type { Candle } from "@domain/schemas/Candle";
import { detectFvgs, pointOfControl } from "../base/math";

const FVG_TAIL = 10;

export type StructureLevelsParams = { window: number; poc_buckets: number };
export const STRUCTURE_LEVELS_DEFAULT_PARAMS: StructureLevelsParams = { window: 50, poc_buckets: 30 };

function readParams(params?: Record<string, unknown>): StructureLevelsParams {
  const window = params?.window;
  const poc_buckets = params?.poc_buckets;
  return {
    window: typeof window === "number" ? window : STRUCTURE_LEVELS_DEFAULT_PARAMS.window,
    poc_buckets: typeof poc_buckets === "number" ? poc_buckets : STRUCTURE_LEVELS_DEFAULT_PARAMS.poc_buckets,
  };
}

export function computeScalars(candles: Candle[], params?: Record<string, unknown>) {
  const { window, poc_buckets } = readParams(params);
  const tail = candles.slice(-window);
  const recentHigh = Math.max(...tail.map((c) => c.high));
  const recentLow = Math.min(...tail.map((c) => c.low));
  const pocPrice = pointOfControl(tail, poc_buckets);
  return { recentHigh, recentLow, pocPrice };
}

export function computePriceLines(candles: Candle[], params?: Record<string, unknown>) {
  const { window, poc_buckets: _poc } = readParams(params);
  const tail = candles.slice(-window);
  const recentHigh = Math.max(...tail.map((c) => c.high));
  const recentLow = Math.min(...tail.map((c) => c.low));
  const fvgs = detectFvgs(candles).slice(-FVG_TAIL);
  const fvgLines = fvgs.flatMap((fvg) => {
    const color = fvg.direction === "bullish"
      ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)";
    return [
      { price: fvg.top, color, style: 0 as const, title: "" },
      { price: fvg.bottom, color, style: 0 as const, title: "" },
    ];
  });
  return [
    { price: recentHigh, color: "#888", style: 2 as const, title: "HH" },
    { price: recentLow, color: "#888", style: 2 as const, title: "LL" },
    ...fvgLines,
  ];
}
