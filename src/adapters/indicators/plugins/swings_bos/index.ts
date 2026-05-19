import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { computeMarkers, computeScalars } from "./compute";
import { swingsBosMetadata } from "./metadata";
import { detectorFragment, featuredFewShotExample, reviewerFragment } from "./promptFragments";

const SWINGS_BOS_PARAMS_SCHEMA = z
  .object({
    lookback: z.number().int().min(1).max(10),
  })
  .strict();

export const swingsBosPlugin: IndicatorPlugin = {
  ...swingsBosMetadata,
  computeScalars: (candles, params) => computeScalars(candles, params),
  computeSeries: (candles, params) => {
    const m = computeMarkers(candles, params);
    // TradingView convention : swing high → arrow pointing up above the
    // candle (continuing the upward trend the pivot terminates), swing
    // low → arrow pointing down below the candle. Matches what an LLM
    // trained on TV screenshots expects to see.
    const markers = [
      ...m.swingHighs.map((s) => ({
        index: s.index,
        position: "above" as const,
        color: "#ef5350",
        shape: "arrowUp" as const,
        text: "H",
      })),
      ...m.swingLows.map((s) => ({
        index: s.index,
        position: "below" as const,
        color: "#26a69a",
        shape: "arrowDown" as const,
        text: "L",
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
  chartPane: "price_overlay",
  renderConfig: {
    pane: "price_overlay",
    palette: ["#94a3b8"],
  },
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  featuredFewShotExample,
  breakdownAxes: ["structure"],
  paramsSchema: SWINGS_BOS_PARAMS_SCHEMA,
};
