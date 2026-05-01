import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { swingsBosMetadata } from "./metadata";
import { computeScalars, computeMarkers } from "./compute";
import { detectorFragment, reviewerFragment, featuredFewShotExample } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

const SWINGS_BOS_PARAMS_SCHEMA = z.object({
  lookback: z.number().int().min(1).max(10),
}).strict();

export const swingsBosPlugin: IndicatorPlugin = {
  ...swingsBosMetadata,
  computeScalars: (candles, params) => computeScalars(candles, params),
  computeSeries: (candles, params) => {
    const m = computeMarkers(candles, params);
    const markers = [
      ...m.swingHighs.map((s) => ({
        index: s.index, position: "above" as const, color: "#ef5350",
        shape: "arrowDown" as const, text: "H",
      })),
      ...m.swingLows.map((s) => ({
        index: s.index, position: "below" as const, color: "#26a69a",
        shape: "arrowUp" as const, text: "L",
      })),
    ];
    return { kind: "markers", markers };
  },
  scalarSchemaFragment: () => ({
    lastSwingHigh: z.number().nullable(),
    lastSwingHighAge: z.number().int().nonnegative().nullable(),
    lastSwingLow: z.number().nullable(),
    lastSwingLowAge: z.number().int().nonnegative().nullable(),
    bosState: z.enum(["bullish", "bearish", "none"]),
  }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  featuredFewShotExample,
  breakdownAxes: ["structure"],
  paramsSchema: SWINGS_BOS_PARAMS_SCHEMA,
};
