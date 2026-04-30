import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { liquidityPoolsMetadata } from "./metadata";
import { computeScalars, computePriceLines } from "./compute";
import { detectorFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

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
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
  breakdownAxes: ["structure"],
};
