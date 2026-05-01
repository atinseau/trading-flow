import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { structureLevelsMetadata } from "./metadata";
import { computeScalars, computePriceLines } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const structureLevelsPlugin: IndicatorPlugin = {
  ...structureLevelsMetadata,
  computeScalars,
  computeSeries: (c) => ({ kind: "priceLines", lines: computePriceLines(c) }),
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
};
