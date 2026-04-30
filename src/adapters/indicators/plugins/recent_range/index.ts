import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { recentRangeMetadata } from "./metadata";
import { computeScalars } from "./compute";
import { detectorFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const recentRangePlugin: IndicatorPlugin = {
  ...recentRangeMetadata,
  computeScalars,
  computeSeries: (c) => {
    const s = computeScalars(c);
    return {
      kind: "priceLines",
      lines: [
        { price: s.recentHigh, color: "#888", style: 2, title: "HH" },
        { price: s.recentLow, color: "#888", style: 2, title: "LL" },
      ],
    };
  },
  scalarSchemaFragment: () => ({ recentHigh: z.number(), recentLow: z.number() }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
  breakdownAxes: ["structure"],
  preFilterCriterion: "near_pivot",
};
