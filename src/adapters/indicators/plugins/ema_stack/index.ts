import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { emaStackMetadata } from "./metadata";
import { computeScalars, computeSeries } from "./compute";
import { detectorFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const emaStackPlugin: IndicatorPlugin = {
  ...emaStackMetadata,
  computeScalars,
  computeSeries: (c) => ({ kind: "lines", series: computeSeries(c) }),
  scalarSchemaFragment: () => ({
    ema20: z.number(), ema50: z.number(), ema200: z.number(),
  }),
  chartScript: CHART_SCRIPT,
  chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
};
