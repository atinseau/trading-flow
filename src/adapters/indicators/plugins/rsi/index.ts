import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { computeRsiScalar, computeRsiSeries } from "./compute";
import { rsiMetadata } from "./metadata";
import { detectorFragment, reviewerFragment } from "./promptFragments";

const RSI_PARAMS_SCHEMA = z
  .object({
    period: z.number().int().min(2).max(50),
  })
  .strict();

export const rsiPlugin: IndicatorPlugin = {
  ...rsiMetadata,

  computeScalars: (candles, params) => computeRsiScalar(candles, params),
  computeScalarHistory: (candles, params, n) => {
    // Reuse the full-length series already computed for the chart, then
    // tail-slice. Keeps the calc path single-source-of-truth and avoids
    // duplicating the Wilder smoothing logic in compute.ts.
    const full = computeRsiSeries(candles, params);
    return { rsi: full.slice(-n) };
  },
  computeSeries: (candles, params) => ({
    kind: "compound",
    parts: [
      { kind: "lines", series: { rsi: computeRsiSeries(candles, params) } },
      // Visible overbought / oversold reference lines + invisible 0/100
      // anchors. Together with `renderConfig.priceScaleOptions.autoScale:
      // false`, this clamps the RSI pane to the canonical [0, 100] range
      // so 70 / 30 are always at the same vertical position regardless of
      // the actual data spread.
      {
        kind: "priceLines",
        lines: [
          { price: 70, color: "#aaa", style: 1, title: "" },
          { price: 30, color: "#aaa", style: 1, title: "" },
          // alpha=0 anchors — only there to expand the auto-fit range to
          // [0, 100] before autoScale gets disabled.
          { price: 100, color: "rgba(0,0,0,0)", style: 0, title: "" },
          { price: 0, color: "rgba(0,0,0,0)", style: 0, title: "" },
        ],
      },
    ],
  }),

  scalarSchemaFragment: () => ({ rsi: z.number().min(0).max(100) }),

  chartPane: "secondary",
  secondaryPaneStretch: 13,
  renderConfig: {
    pane: "secondary",
    palette: ["#14b8a6"],
    secondaryPaneStretch: 13,
    seriesLabels: { rsi: "RSI" },
    // Lock the pane to RSI's theoretical [0, 100] range so the 70/30
    // reference lines stay at consistent vertical positions across charts.
    priceScaleOptions: { autoScale: false, scaleMargins: { top: 0.05, bottom: 0.05 } },
  },

  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,

  preFilterCriterion: "rsi_extreme_distance",

  paramsSchema: RSI_PARAMS_SCHEMA,
};
