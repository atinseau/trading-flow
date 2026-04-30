import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { rsiMetadata } from "./metadata";
import { computeRsiScalar, computeRsiSeries } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const rsiPlugin: IndicatorPlugin = {
  ...rsiMetadata,

  computeScalars: (candles) => computeRsiScalar(candles),
  computeSeries: (candles) => ({ kind: "lines", series: { rsi: computeRsiSeries(candles) } }),

  scalarSchemaFragment: () => ({ rsi: z.number().min(0).max(100) }),

  chartScript: CHART_SCRIPT,
  chartPane: "secondary",
  secondaryPaneStretch: 13,

  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,

  preFilterCriterion: "rsi_extreme_distance",
};
