import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { pocMetadata } from "./metadata";
import { computeScalars } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const pocPlugin: IndicatorPlugin = {
  ...pocMetadata,
  computeScalars,
  computeSeries: () => ({ kind: "lines", series: {} }),
  scalarSchemaFragment: () => ({ pocPrice: z.number() }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  breakdownAxes: ["structure"],
};
