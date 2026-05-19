import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { computeScalars, computeSeries } from "./compute";
import { emaStackMetadata } from "./metadata";
import { detectorFragment } from "./promptFragments";

const EMA_STACK_PARAMS_SCHEMA = z
  .object({
    period_short: z.number().int().min(2).max(500),
    period_mid: z.number().int().min(2).max(500),
    period_long: z.number().int().min(2).max(500),
  })
  .strict()
  .refine((v) => v.period_short < v.period_mid && v.period_mid < v.period_long, {
    message: "must satisfy period_short < period_mid < period_long",
  });

export const emaStackPlugin: IndicatorPlugin = {
  ...emaStackMetadata,
  computeScalars: (candles, params) => computeScalars(candles, params),
  computeSeries: (candles, params) => ({ kind: "lines", series: computeSeries(candles, params) }),
  scalarSchemaFragment: () => ({
    emaShort: z.number(),
    emaMid: z.number(),
    emaLong: z.number(),
  }),
  chartPane: "price_overlay",
  renderConfig: {
    pane: "price_overlay",
    palette: ["#3b82f6", "#f59e0b", "#ef4444"],
    seriesLabels: { emaShort: "EMA short", emaMid: "EMA mid", emaLong: "EMA long" },
  },
  detectorPromptFragment: detectorFragment,
  paramsSchema: EMA_STACK_PARAMS_SCHEMA,
};
