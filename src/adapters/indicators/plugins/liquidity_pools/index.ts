import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { CHART_SCRIPT } from "./chartScript";
import { computePriceLines, computeScalars } from "./compute";
import { liquidityPoolsMetadata } from "./metadata";
import { detectorFragment, featuredFewShotExample } from "./promptFragments";

export const liquidityPoolsPlugin: IndicatorPlugin = {
  ...liquidityPoolsMetadata,
  computeScalars,
  computeSeries: (c) => ({ kind: "priceLines", lines: computePriceLines(c) }),
  scalarSchemaFragment: () => ({
    equalHighsCount: z.number().int().nonnegative(),
    equalLowsCount: z.number().int().nonnegative(),
    topEqualHighs: z.array(z.object({ price: z.number(), touches: z.number().int() })).max(3),
    topEqualLows: z.array(z.object({ price: z.number(), touches: z.number().int() })).max(3),
  }),
  chartScript: CHART_SCRIPT,
  chartPane: "price_overlay",
  renderConfig: {
    pane: "price_overlay",
    palette: ["#a78bfa"],
  },
  detectorPromptFragment: detectorFragment,
  featuredFewShotExample,
  breakdownAxes: ["structure"],
};
