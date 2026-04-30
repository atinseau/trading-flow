import type { Candle } from "@domain/schemas/Candle";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";

export type PreFilterResult = { passed: boolean; reasons: string[] };

export function evaluatePreFilter(
  candles: Candle[],
  indicators: Record<string, unknown>,
  config: WatchConfig["pre_filter"],
): PreFilterResult {
  if (!config.enabled || config.mode === "off") {
    return { passed: true, reasons: ["disabled"] };
  }

  const t = config.thresholds;
  const reasons: string[] = [];

  const atr = typeof indicators.atr === "number" ? indicators.atr : 0;
  const atrMa20 = typeof indicators.atrMa20 === "number" ? indicators.atrMa20 : 0;
  const lastVolume = typeof indicators.lastVolume === "number" ? indicators.lastVolume : 0;
  const volumeMa20 = typeof indicators.volumeMa20 === "number" ? indicators.volumeMa20 : 0;
  const rsi = typeof indicators.rsi === "number" ? indicators.rsi : 50;
  const recentHigh = typeof indicators.recentHigh === "number" ? indicators.recentHigh : null;
  const recentLow = typeof indicators.recentLow === "number" ? indicators.recentLow : null;

  if (atrMa20 > 0 && atr / atrMa20 > t.atr_ratio_min) {
    reasons.push(`atr_ratio=${(atr / atrMa20).toFixed(2)}`);
  }
  if (volumeMa20 > 0 && lastVolume / volumeMa20 > t.volume_spike_min) {
    reasons.push(`volume_spike=${(lastVolume / volumeMa20).toFixed(2)}`);
  }
  if (Math.abs(rsi - 50) > t.rsi_extreme_distance) {
    reasons.push(`rsi_extreme=${rsi.toFixed(1)}`);
  }
  const last = candles[candles.length - 1]?.close;
  if (last != null && recentHigh != null && recentLow != null) {
    const distHigh = Math.abs(recentHigh - last) / last;
    const distLow = Math.abs(recentLow - last) / last;
    if (Math.min(distHigh, distLow) < 0.003) reasons.push("near_pivot");
  }

  return { passed: reasons.length > 0, reasons };
}
