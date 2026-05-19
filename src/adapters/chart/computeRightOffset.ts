/**
 * How many candles of empty space to keep on the right side of the chart.
 * Why : the right-axis labels (BB Up, EMA short, Fib 0.382, …) stack
 * vertically ; past ~6 stacked labels they overflow into the candle area
 * and mask the last 3-5 bars — exactly the bars the LLM needs most.
 *
 * Empirical paliers (see `test/visual/chart-visibility.test.ts`). Tuned
 * for 1280×720 viewports.
 */
export function computeRightOffset(opts: {
  /** Lines on the price-overlay pane (each produces one label). */
  priceOverlayLineCount: number;
  /** priceLines on the main series (each produces one label). */
  priceLineCount: number;
}): number {
  const total = opts.priceOverlayLineCount + opts.priceLineCount;
  if (total <= 5) return 5;
  if (total <= 10) return 12;
  if (total <= 15) return 16;
  return 20;
}
