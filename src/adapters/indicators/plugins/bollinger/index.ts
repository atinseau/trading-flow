import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { bollingerMetadata } from "./metadata";
import { computeScalars, computeSeries } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const bollingerPlugin: IndicatorPlugin = {
  ...bollingerMetadata,
  computeScalars,
  computeSeries: (c) => {
    const s = computeSeries(c);
    return { kind: "lines", series: { upper: s.upper, lower: s.lower, middle: s.middle } };
  },
  scalarSchemaFragment: () => ({
    bbUpper: z.number(), bbMiddle: z.number(), bbLower: z.number(),
    bbBandwidthPct: z.number(),
    bbBandwidthPercentile200: z.number().min(0).max(100),
  }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
};
