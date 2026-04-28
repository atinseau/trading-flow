import type { Candle } from "@domain/schemas/Candle";
import type { WatchConfig } from "@domain/schemas/Config";
import type { Indicators } from "@domain/schemas/Indicators";

export type PreFilterResult = { passed: boolean; reasons: string[] };

export function evaluatePreFilter(
  candles: Candle[],
  indicators: Indicators,
  config: WatchConfig["pre_filter"],
): PreFilterResult {
  if (!config.enabled || config.mode === "off") {
    return { passed: true, reasons: ["disabled"] };
  }

  const t = config.thresholds;
  const reasons: string[] = [];

  if (indicators.atrMa20 > 0 && indicators.atr / indicators.atrMa20 > t.atr_ratio_min) {
    reasons.push(`atr_ratio=${(indicators.atr / indicators.atrMa20).toFixed(2)}`);
  }
  if (
    indicators.volumeMa20 > 0 &&
    indicators.lastVolume / indicators.volumeMa20 > t.volume_spike_min
  ) {
    reasons.push(`volume_spike=${(indicators.lastVolume / indicators.volumeMa20).toFixed(2)}`);
  }
  if (Math.abs(indicators.rsi - 50) > t.rsi_extreme_distance) {
    reasons.push(`rsi_extreme=${indicators.rsi.toFixed(1)}`);
  }
  const last = candles[candles.length - 1]?.close;
  if (last != null) {
    const distHigh = Math.abs(indicators.recentHigh - last) / last;
    const distLow = Math.abs(indicators.recentLow - last) / last;
    if (Math.min(distHigh, distLow) < 0.003) reasons.push("near_pivot");
  }

  return { passed: reasons.length > 0, reasons };
}
