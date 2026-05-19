import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { computeScalars, computeSeries } from "./compute";
import { macdMetadata } from "./metadata";
import { detectorFragment, reviewerFragment } from "./promptFragments";

const MACD_PARAMS_SCHEMA = z
  .object({
    fast: z.number().int().min(2).max(50),
    slow: z.number().int().min(2).max(50),
    signal: z.number().int().min(2).max(50),
  })
  .strict()
  .refine((v) => v.fast < v.slow, {
    message: "fast period must be < slow period",
  });

export const macdPlugin: IndicatorPlugin = {
  ...macdMetadata,
  computeScalars: (candles, params) => computeScalars(candles, params),
  computeSeries: (candles, params) => {
    const s = computeSeries(candles, params);
    return { kind: "lines", series: { macd: s.macd, signal: s.signal, hist: s.hist } };
  },
  scalarSchemaFragment: () => ({ macd: z.number(), macdSignal: z.number(), macdHist: z.number() }),
  chartPane: "secondary",
  secondaryPaneStretch: 13,
  renderConfig: {
    pane: "secondary",
    palette: ["#3b82f6", "#f59e0b"],
    secondaryPaneStretch: 15,
    seriesLabels: { macd: "MACD", signal: "Signal", hist: "Hist" },
  },
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  paramsSchema: MACD_PARAMS_SCHEMA,
};
