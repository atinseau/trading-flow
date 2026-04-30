import type { Candle } from "@domain/schemas/Candle";
import { movingAverage, percentileOf, rollingMaAligned } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const volumes = candles.map((c) => c.volume);
  return {
    volumeMa20: movingAverage(volumes, 20),
    lastVolume: volumes[volumes.length - 1] ?? 0,
    volumePercentile200: percentileOf(
      volumes[volumes.length - 1] ?? 0,
      volumes.slice(-201, -1),
    ),
  };
}
export function computeSeries(candles: Candle[]) {
  const volumes: (number | null)[] = candles.map((c) => c.volume);
  return { volumeMa20: rollingMaAligned(volumes, 20) };
}
