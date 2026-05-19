import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { computeScalars, computeSeries } from "./compute";
import { bollingerMetadata } from "./metadata";
import { detectorFragment, featuredFewShotExample, reviewerFragment } from "./promptFragments";

const BOLLINGER_PARAMS_SCHEMA = z
  .object({
    period: z.number().int().min(5).max(100),
    std_mul: z.number().min(0.5).max(4),
  })
  .strict();

export const bollingerPlugin: IndicatorPlugin = {
  ...bollingerMetadata,
  computeScalars: (candles, params) => computeScalars(candles, params),
  computeSeries: (candles, params) => {
    const s = computeSeries(candles, params);
    return { kind: "lines", series: { upper: s.upper, lower: s.lower, middle: s.middle } };
  },
  scalarSchemaFragment: () => ({
    bbUpper: z.number(),
    bbMiddle: z.number(),
    bbLower: z.number(),
    bbBandwidthPct: z.number(),
    bbBandwidthPercentile200: z.number().min(0).max(100),
  }),
  chartPane: "price_overlay",
  renderConfig: {
    pane: "price_overlay",
    palette: ["#a78bfa", "#a78bfa", "#a78bfa"],
    seriesLabels: { upper: "BB up", middle: "BB mid", lower: "BB lo" },
  },
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  featuredFewShotExample,
  paramsSchema: BOLLINGER_PARAMS_SCHEMA,
};
