import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { macdMetadata } from "./metadata";
import { computeScalars, computeSeries } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const macdPlugin: IndicatorPlugin = {
  ...macdMetadata,
  computeScalars,
  computeSeries: (c) => {
    const s = computeSeries(c);
    return { kind: "lines", series: { macd: s.macd, signal: s.signal, hist: s.hist } };
  },
  scalarSchemaFragment: () => ({ macd: z.number(), macdSignal: z.number(), macdHist: z.number() }),
  chartScript: CHART_SCRIPT, chartPane: "secondary", secondaryPaneStretch: 13,
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
};
