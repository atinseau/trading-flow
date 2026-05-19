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
  computeScalarHistory: (candles, params, n) => {
    if (n <= 0) return { upper: [], middle: [], lower: [] };
    const s = computeSeries(candles, params);
    return {
      upper: s.upper.slice(-n),
      middle: s.middle.slice(-n),
      lower: s.lower.slice(-n),
    };
  },
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
    // Same hue for the 3 lines (BB is a single indicator visually) but the
    // middle SMA20 is dashed + thinner so the eye reads the upper+lower
    // pair as the envelope and middle as the centerline. Closer to the
    // TradingView default look.
    palette: ["#a78bfa", "#a78bfa", "#a78bfa"],
    seriesLabels: { upper: "BB up", middle: "BB mid", lower: "BB lo" },
    linesStyles: {
      upper: { lineWidth: 1 },
      middle: { lineWidth: 1, lineStyle: 2 },
      lower: { lineWidth: 1 },
    },
  },
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  featuredFewShotExample,
  paramsSchema: BOLLINGER_PARAMS_SCHEMA,
};
