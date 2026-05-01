import { z } from "zod";

/**
 * Last-value scalars injected into LLM prompts. Series for chart rendering
 * live in `IndicatorCalculator.computeSeries` (separate type, see
 * `domain/ports/IndicatorCalculator.ts`).
 *
 * Keep this lean: every field added here is a paid token on every detector
 * call. Add a scalar only if it's something the LLM needs to *cite* in
 * verdict reasoning. If it's only useful visually, expose it via the series
 * and skip it here.
 */
export const IndicatorsSchema = z.object({
  // Momentum
  rsi: z.number().min(0).max(100),

  // Trend (EMA stack)
  ema20: z.number(),
  ema50: z.number(),
  ema200: z.number(),

  // Volatility
  atr: z.number().nonnegative(),
  atrMa20: z.number().nonnegative(),
  /**
   * ATR Z-score over the last 200 candles (sample std). Negative = current
   * volatility well below recent baseline (compression — coil before
   * expansion). Positive = expansion regime. Useful threshold: < -1 = squeeze,
   * > +1.5 = exhaustion-territory volatility.
   */
  atrZScore200: z.number(),

  // Volume
  volumeMa20: z.number().nonnegative(),
  lastVolume: z.number().nonnegative(),
  /**
   * Rolling-percentile of last-candle volume vs last 200 candles. 0 = lowest
   * in window, 100 = highest. Per-asset calibration — replaces the
   * Medium-blog "1.5× MA20" magic number that fits BTC poorly and majors well.
   */
  volumePercentile200: z.number().min(0).max(100),

  // Pivots (last 50 candles)
  recentHigh: z.number(),
  recentLow: z.number(),

  // Session VWAP — institutional anchor. Near-VWAP price = mean-reversion
  // candidate; far above/below = trend stretched.
  vwapSession: z.number(),
  /** Signed pct distance: (close - vwap) / vwap × 100. */
  priceVsVwapPct: z.number(),

  // Bollinger Bands (20, 2σ) — bbMiddle is the SMA20 (not the EMA20).
  bbUpper: z.number(),
  bbMiddle: z.number(),
  bbLower: z.number(),
  /** (upper - lower) / middle × 100. */
  bbBandwidthPct: z.number(),
  /** Percentile of current BB bandwidth vs last 200 candles. Asset-calibrated squeeze detector: < 15 = squeeze for THIS asset. */
  bbBandwidthPercentile200: z.number().min(0).max(100),

  // MACD (12, 26, 9)
  macd: z.number(),
  macdSignal: z.number(),
  macdHist: z.number(),

  // Most recent confirmed swing high / low + age in candles.
  lastSwingHigh: z.number().nullable(),
  lastSwingHighAge: z.number().int().nonnegative().nullable(),
  lastSwingLow: z.number().nullable(),
  lastSwingLowAge: z.number().int().nonnegative().nullable(),

  /**
   * Last detected break-of-structure direction. "bullish" = price made a
   * higher-high closing above the previous swing high. "bearish" = lower-low
   * closing below previous swing low. "none" = range / no recent BOS.
   */
  bosState: z.enum(["bullish", "bearish", "none"]),

  // Volume Profile (cheap approximation): price level holding the most volume
  // over the recent window. Functions as a magnet / mean-reversion anchor.
  pocPrice: z.number(),

  // Equal highs / lows count in the last 50 candles (within 0.1% tolerance).
  // High counts → liquidity pool there → likely sweep target.
  equalHighsCount: z.number().int().nonnegative(),
  equalLowsCount: z.number().int().nonnegative(),

  /**
   * Top-3 strongest equal-pivot clusters in the recent window. Sorted by
   * cluster strength (touch count). Used by the detector prompt to cite
   * exact liquidity-pool prices in proposals (not just bare counts).
   */
  topEqualHighs: z.array(z.object({ price: z.number(), touches: z.number().int() })).max(3),
  topEqualLows: z.array(z.object({ price: z.number(), touches: z.number().int() })).max(3),
});

export type Indicators = z.infer<typeof IndicatorsSchema>;
