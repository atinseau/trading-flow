import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { structureLevelsMetadata } from "./metadata";
import { computeScalars, computePriceLines } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

const STRUCTURE_LEVELS_PARAMS_SCHEMA = z.object({
  window: z.number().int().min(10).max(200),
  poc_buckets: z.number().int().min(10).max(100),
}).strict();

export const structureLevelsPlugin: IndicatorPlugin = {
  ...structureLevelsMetadata,
  computeScalars: (candles, params) => computeScalars(candles, params),
  computeSeries: (candles, params) => ({ kind: "priceLines", lines: computePriceLines(candles, params) }),
  scalarSchemaFragment: () => ({
    recentHigh: z.number(),
    recentLow: z.number(),
    pocPrice: z.number(),
  }),
  chartScript: CHART_SCRIPT,
  chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  breakdownAxes: ["structure"],
  preFilterCriterion: "near_pivot",
  paramsSchema: STRUCTURE_LEVELS_PARAMS_SCHEMA,
};
