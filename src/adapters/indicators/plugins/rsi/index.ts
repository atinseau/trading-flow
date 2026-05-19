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
  computeSeries: (candles, params) => ({
    kind: "lines",
    series: { rsi: computeRsiSeries(candles, params) },
  }),

  scalarSchemaFragment: () => ({ rsi: z.number().min(0).max(100) }),

  chartPane: "secondary",
  secondaryPaneStretch: 13,
  renderConfig: {
    pane: "secondary",
    palette: ["#14b8a6"],
    secondaryPaneStretch: 13,
    seriesLabels: { rsi: "RSI" },
  },

  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,

  preFilterCriterion: "rsi_extreme_distance",

  paramsSchema: RSI_PARAMS_SCHEMA,
};
