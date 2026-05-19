import type { IndicatorSeriesContribution, RenderConfig } from "@domain/charts/types";

/**
 * Longest chip *title* string that will appear on the price-axis strip for
 * this contribution. Matches `contributionRenderer.labelFor()` precedence —
 * `seriesLabels[key]` if set, else the priceLine's `title`, else `id:key`.
 *
 * Used to size the right-pad : a Bollinger-only chart needs ~"BB mid" wide
 * (5-6 chars), but a Fibonacci-only chart needs ~"Fib anchor H" (12 chars).
 * Constant-budget sizing wastes screen space on the cheap case.
 */
export function maxAxisLabelLength(
  id: string,
  contribution: IndicatorSeriesContribution,
  renderConfig: Pick<RenderConfig, "seriesLabels">,
): number {
  function labelFor(name: string): string {
    return renderConfig.seriesLabels?.[name] ?? `${id}:${name}`;
  }
  function walk(c: IndicatorSeriesContribution): number {
    switch (c.kind) {
      case "lines":
        return Object.keys(c.series).reduce(
          (max, k) => Math.max(max, labelFor(k).length),
          0,
        );
      case "priceLines":
        return c.lines.reduce((max, l) => (l.title ? Math.max(max, l.title.length) : max), 0);
      case "histogram": {
        const t = renderConfig.seriesLabels?.histogram ?? id;
        return t.length;
      }
      case "markers":
      case "bands":
        return 0;
      case "compound":
        return c.parts.reduce((max, p) => Math.max(max, walk(p)), 0);
    }
  }
  return walk(contribution);
}

/**
 * How many labels a contribution stacks on its pane's price axis. Mirrors
 * `contributionRenderer.applyContribution` :
 *
 *   - `lines`       → one label per series (`title` non-empty by construction
 *                     via `seriesLabels` / `<id>:<name>` fallback).
 *   - `priceLines`  → only those with non-empty `title` (renderer sets
 *                     `axisLabelVisible: line.title !== ""`).
 *   - `histogram`   → one label (the series title).
 *   - `markers`     → 0 (drawn on candles, not on the axis).
 *   - `bands`       → 0 (primitive overlay, no axis tag).
 *   - `compound`    → sum of parts.
 *
 * Why this matters : the chart needs to know whether any chips will be
 * drawn on the price axis, so it can decide between "1 candle of breathing
 * room" (naked chart) and "reserve a chip-strip-wide gap" (chips present).
 * A naive "1 per plugin" count under-detects (fibonacci alone contributes
 * 7 priceLines, ema_stack 3 lines) and risks reserving 0 candles when in
 * fact a full chip strip will need to render.
 */
export function countAxisLabels(c: IndicatorSeriesContribution): number {
  switch (c.kind) {
    case "lines":
      return Object.keys(c.series).length;
    case "priceLines":
      return c.lines.filter((l) => l.title !== "").length;
    case "histogram":
      return 1;
    case "markers":
    case "bands":
      return 0;
    case "compound":
      return c.parts.reduce((acc, p) => acc + countAxisLabels(p), 0);
  }
}
