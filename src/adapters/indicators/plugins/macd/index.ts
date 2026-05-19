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
  computeScalarHistory: (candles, params, n) => {
    if (n <= 0) return { macd: [], signal: [], hist: [] };
    const s = computeSeries(candles, params);
    return {
      macd: s.macd.slice(-n),
      signal: s.signal.slice(-n),
      hist: s.hist.slice(-n),
    };
  },
  computeSeries: (candles, params) => {
    const s = computeSeries(candles, params);
    return {
      kind: "compound",
      parts: [
        { kind: "lines", series: { macd: s.macd, signal: s.signal } },
        // Histogram with green/red coloring per sign (positive = bullish).
        {
          kind: "histogram",
          values: s.hist.map((v) =>
            v == null
              ? null
              : { value: v, color: v >= 0 ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)" },
          ),
        },
      ],
    };
  },
  scalarSchemaFragment: () => ({ macd: z.number(), macdSignal: z.number(), macdHist: z.number() }),
  chartPane: "secondary",
  secondaryPaneStretch: 13,
  renderConfig: {
    pane: "secondary",
    palette: ["#3b82f6", "#f59e0b"],
    secondaryPaneStretch: 15,
    seriesLabels: { macd: "MACD", signal: "Signal", histogram: "Hist" },
  },
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  paramsSchema: MACD_PARAMS_SCHEMA,
};
