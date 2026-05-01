import type { Candle } from "@domain/schemas/Candle";
import type { Indicators } from "@domain/schemas/Indicators";

/**
 * Time-series aligned with the candle array passed to the calculator. Each
 * indexed array has length equal to the candle count; entries before warm-up
 * or where the indicator is undefined are `null`.
 *
 * `swingHighs` / `swingLows` are sparse (one entry per detected pivot, with
 * a candle index) — used as chart markers, not continuous lines.
 *
 * `fvgs` is a list of 3-candle Fair Value Gap zones (top/bottom price band
 * + the candle index where the gap formed).
 */
export type IndicatorSeries = {
  // Continuous overlays on the price pane.
  ema20: (number | null)[];
  ema50: (number | null)[];
  ema200: (number | null)[];
  vwap: (number | null)[];
  bbUpper: (number | null)[];
  bbMiddle: (number | null)[];
  bbLower: (number | null)[];

  // Sub-pane series.
  rsi: (number | null)[];
  atr: (number | null)[];
  atrMa20: (number | null)[];
  volumeMa20: (number | null)[];
  macd: (number | null)[];
  macdSignal: (number | null)[];
  macdHist: (number | null)[];

  // Sparse markers (price + candle index).
  swingHighs: { index: number; price: number }[];
  swingLows: { index: number; price: number }[];

  // Fair Value Gaps detected on 3-candle pattern. `top` / `bottom` define the
  // vertical band; `index` is the middle candle of the gap.
  fvgs: { index: number; top: number; bottom: number; direction: "bullish" | "bearish" }[];

  // Equal highs / lows (pivot price + indices where the level was tagged).
  equalHighs: { price: number; indices: number[] }[];
  equalLows: { price: number; indices: number[] }[];
};

export interface IndicatorCalculator {
  compute(candles: Candle[]): Promise<Indicators>;
  computeSeries(candles: Candle[]): Promise<IndicatorSeries>;
}
