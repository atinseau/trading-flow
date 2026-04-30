import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { atrMetadata } from "./metadata";
import { computeScalars, computeSeries } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const atrPlugin: IndicatorPlugin = {
  ...atrMetadata,
  computeScalars,
  computeSeries: (c) => {
    const s = computeSeries(c);
    return { kind: "lines", series: { atr: s.atr, atrMa20: s.atrMa20 } };
  },
  scalarSchemaFragment: () => ({
    atr: z.number().nonnegative(),
    atrMa20: z.number().nonnegative(),
    atrZScore200: z.number(),
  }),
  chartScript: CHART_SCRIPT, chartPane: "secondary", secondaryPaneStretch: 11,
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  preFilterCriterion: "atr_ratio_min",
};
