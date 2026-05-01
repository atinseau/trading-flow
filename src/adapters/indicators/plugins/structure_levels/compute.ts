import type { Candle } from "@domain/schemas/Candle";
import { detectFvgs, pointOfControl } from "../base/math";

const RECENT_WINDOW = 50;
const POC_BUCKETS = 30;
const FVG_TAIL = 10;

export function computeScalars(candles: Candle[]) {
  const tail = candles.slice(-RECENT_WINDOW);
  const recentHigh = Math.max(...tail.map((c) => c.high));
  const recentLow = Math.min(...tail.map((c) => c.low));
  const pocPrice = pointOfControl(tail, POC_BUCKETS);
  return { recentHigh, recentLow, pocPrice };
}

export function computePriceLines(candles: Candle[]) {
  const tail = candles.slice(-RECENT_WINDOW);
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
