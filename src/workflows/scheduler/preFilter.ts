import type { Candle } from "@domain/schemas/Candle";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

export type PreFilterResult = { passed: boolean; reasons: string[] };

export function evaluatePreFilter(
  candles: Candle[],
  scalars: Record<string, unknown>,
  config: WatchConfig["pre_filter"],
  plugins: ReadonlyArray<IndicatorPlugin>,
): PreFilterResult {
  if (!config.enabled || config.mode === "off") {
    return { passed: true, reasons: ["disabled"] };
  }

  const criteria = new Set(
    plugins
      .map((p) => p.preFilterCriterion)
      .filter((c): c is NonNullable<typeof c> => c != null),
  );
  if (criteria.size === 0) {
    return { passed: true, reasons: ["no_active_criteria"] };
  }

  const reasons: string[] = [];
  const t = config.thresholds;
  const num = (k: string) => {
    const v = scalars[k];
    return typeof v === "number" ? v : undefined;
  };

  if (criteria.has("atr_ratio_min")) {
    const atr = num("atr"), atrMa = num("atrMa20");
    if (atr !== undefined && atrMa !== undefined && atrMa > 0 && atr / atrMa > t.atr_ratio_min) {
      reasons.push(`atr_ratio=${(atr / atrMa).toFixed(2)}`);
    }
  }
  if (criteria.has("volume_spike_min")) {
    const last = num("lastVolume"), ma = num("volumeMa20");
    if (last !== undefined && ma !== undefined && ma > 0 && last / ma > t.volume_spike_min) {
      reasons.push(`volume_spike=${(last / ma).toFixed(2)}`);
    }
  }
  if (criteria.has("rsi_extreme_distance")) {
    const rsi = num("rsi");
    if (rsi !== undefined && Math.abs(rsi - 50) > t.rsi_extreme_distance) {
      reasons.push(`rsi_extreme=${rsi.toFixed(1)}`);
    }
  }
  if (criteria.has("near_pivot")) {
    const high = num("recentHigh"), low = num("recentLow");
    const last = candles[candles.length - 1]?.close;
    if (high !== undefined && low !== undefined && last != null) {
      const distHigh = Math.abs(high - last) / last;
      const distLow = Math.abs(low - last) / last;
      if (Math.min(distHigh, distLow) < t.near_pivot_distance_pct / 100) reasons.push("near_pivot");
    }
  }

  if (config.mode === "lenient") {
    return { passed: reasons.length > 0, reasons };
  }
  // strict mode: must hit every active criterion
  return { passed: reasons.length === criteria.size, reasons };
}
