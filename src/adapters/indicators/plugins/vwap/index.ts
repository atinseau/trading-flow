import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { vwapMetadata } from "./metadata";
import { computeScalars, computeSeries } from "./compute";
import { detectorFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const vwapPlugin: IndicatorPlugin = {
  ...vwapMetadata,
  computeScalars,
  computeSeries: (c) => ({ kind: "lines", series: computeSeries(c) }),
  scalarSchemaFragment: () => ({ vwapSession: z.number(), priceVsVwapPct: z.number() }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
};
