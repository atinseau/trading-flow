import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { computeScalars, computeSeries } from "./compute";
import { vwapMetadata } from "./metadata";
import { detectorFragment } from "./promptFragments";

export const vwapPlugin: IndicatorPlugin = {
  ...vwapMetadata,
  computeScalars,
  computeSeries: (c) => ({ kind: "lines", series: computeSeries(c) }),
  scalarSchemaFragment: () => ({ vwapSession: z.number(), priceVsVwapPct: z.number() }),
  chartPane: "price_overlay",
  renderConfig: {
    pane: "price_overlay",
    palette: ["#10b981"],
    seriesLabels: { vwapSession: "VWAP" },
  },
  detectorPromptFragment: detectorFragment,
};
