import type { IndicatorScalars } from "@domain/schemas/Indicators";
import type { HtfContext } from "@domain/services/htfContext";

/**
 * Coarse market-regime classification fed to the finalizer. Pure derivation
 * from existing indicator + HTF data — no extra data fetch.
 *
 * The label is the *primary* call; secondary modifiers (`squeeze`,
 * `volatility_expansion`) are independent of the trend axis.
 */
export type MarketRegime = {
  label: "uptrend" | "downtrend" | "ranging";
  /** True if BB bandwidth < 4 OR ATR z-score < -1 (compression). */
  squeeze: boolean;
  /** True if ATR z-score > +1.5 (volatility expansion). */
  volatilityExpansion: boolean;
  /** Free-form 1-line rationale (for display in prompts). */
  rationale: string;
};

export function classifyRegime(indicators: IndicatorScalars, htf: HtfContext | null): MarketRegime {
  const bbBandwidthPct = (indicators.bbBandwidthPct as number) ?? 0;
  const atrZScore200 = (indicators.atrZScore200 as number) ?? 0;
  const ema20 = (indicators.ema20 as number) ?? 0;
  const ema50 = (indicators.ema50 as number) ?? 0;
  const ema200 = (indicators.ema200 as number) ?? 0;

  const squeeze = bbBandwidthPct < 4 || atrZScore200 < -1;
  const volatilityExpansion = atrZScore200 > 1.5;

  // Primary trend axis: prefer HTF daily regime when available; fall back to
  // local EMA stack. The HTF call here is what makes ranging-vs-trending
  // robust — local EMAs can be momentarily aligned in either direction.
  let label: MarketRegime["label"] = "ranging";
  let rationale = "";

  if (htf && htf.dailyTrend !== "sideways") {
    label = htf.dailyTrend === "uptrend" ? "uptrend" : "downtrend";
    rationale = `Daily HTF in ${htf.dailyTrend}`;
  } else {
    // Local EMA stack alignment.
    if (ema20 > ema50 && ema50 > ema200) {
      label = "uptrend";
      rationale = "EMA20 > EMA50 > EMA200 (bullish stack)";
    } else if (ema20 < ema50 && ema50 < ema200) {
      label = "downtrend";
      rationale = "EMA20 < EMA50 < EMA200 (bearish stack)";
    } else {
      rationale = "EMAs not aligned — ranging";
    }
  }
  if (squeeze)
    rationale += `; squeeze (BB ${bbBandwidthPct.toFixed(2)}%, ATR z=${atrZScore200.toFixed(2)})`;
  if (volatilityExpansion)
    rationale += `; vol expansion (ATR z=${atrZScore200.toFixed(2)})`;

  return { label, squeeze, volatilityExpansion, rationale };
}
