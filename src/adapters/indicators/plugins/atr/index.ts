import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { CHART_SCRIPT } from "./chartScript";
import { computeScalars, computeSeries } from "./compute";
import { atrMetadata } from "./metadata";
import { detectorFragment, reviewerFragment } from "./promptFragments";

const ATR_PARAMS_SCHEMA = z
  .object({
    period: z.number().int().min(2).max(50),
  })
  .strict();

export const atrPlugin: IndicatorPlugin = {
  ...atrMetadata,
  computeScalars: (candles, params) => computeScalars(candles, params),
  computeSeries: (candles, params) => {
    const s = computeSeries(candles, params);
    return { kind: "lines", series: { atr: s.atr, atrMa20: s.atrMa20 } };
  },
  scalarSchemaFragment: () => ({
    atr: z.number().nonnegative(),
    atrMa20: z.number().nonnegative(),
    atrZScore200: z.number(),
  }),
  chartScript: CHART_SCRIPT,
  chartPane: "secondary",
  secondaryPaneStretch: 11,
  renderConfig: {
    pane: "secondary",
    palette: ["#f97316"],
    secondaryPaneStretch: 11,
    seriesLabels: { atr: "ATR", atrMa20: "ATR MA20" },
  },
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  preFilterCriterion: "atr_ratio_min",
  paramsSchema: ATR_PARAMS_SCHEMA,
};
