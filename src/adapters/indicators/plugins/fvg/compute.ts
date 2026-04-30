import type { Candle } from "@domain/schemas/Candle";
import { detectFvgs } from "../base/math";

export function computePriceLines(candles: Candle[]) {
  const fvgs = detectFvgs(candles).slice(-10);
  return fvgs.flatMap((fvg) => {
    const color = fvg.direction === "bullish"
      ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)";
    return [
      { price: fvg.top, color, style: 0 as const, title: "" },
      { price: fvg.bottom, color, style: 0 as const, title: "" },
    ];
  });
}
