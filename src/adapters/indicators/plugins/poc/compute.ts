import type { Candle } from "@domain/schemas/Candle";
import { pointOfControl } from "../base/math";

const RECENT = 50;
const BUCKETS = 30;
export function computeScalars(candles: Candle[]) {
  return { pocPrice: pointOfControl(candles.slice(-RECENT), BUCKETS) };
}
