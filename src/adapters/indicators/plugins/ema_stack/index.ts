import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { emaStackMetadata } from "./metadata";
import { computeScalars, computeSeries } from "./compute";
import { detectorFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

const EMA_STACK_PARAMS_SCHEMA = z.object({
  period_short: z.number().int().min(2).max(500),
  period_mid: z.number().int().min(2).max(500),
  period_long: z.number().int().min(2).max(500),
}).strict().refine((v) => v.period_short < v.period_mid && v.period_mid < v.period_long, {
  message: "must satisfy period_short < period_mid < period_long",
});

export const emaStackPlugin: IndicatorPlugin = {
  ...emaStackMetadata,
  computeScalars: (candles, params) => computeScalars(candles, params),
  computeSeries: (candles, params) => ({ kind: "lines", series: computeSeries(candles, params) }),
  scalarSchemaFragment: () => ({
    ema20: z.number(), ema50: z.number(), ema200: z.number(),
  }),
  chartScript: CHART_SCRIPT,
  chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
  paramsSchema: EMA_STACK_PARAMS_SCHEMA,
};
