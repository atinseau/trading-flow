import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { rsiMetadata } from "./metadata";
import { computeRsiScalar, computeRsiSeries } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

const RSI_PARAMS_SCHEMA = z.object({
  period: z.number().int().min(2).max(50),
}).strict();

export const rsiPlugin: IndicatorPlugin = {
  ...rsiMetadata,

  computeScalars: (candles, params) => computeRsiScalar(candles, params),
  computeSeries: (candles, params) => ({ kind: "lines", series: { rsi: computeRsiSeries(candles, params) } }),

  scalarSchemaFragment: () => ({ rsi: z.number().min(0).max(100) }),

  chartScript: CHART_SCRIPT,
  chartPane: "secondary",
  secondaryPaneStretch: 13,

  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,

  preFilterCriterion: "rsi_extreme_distance",

  paramsSchema: RSI_PARAMS_SCHEMA,
};
