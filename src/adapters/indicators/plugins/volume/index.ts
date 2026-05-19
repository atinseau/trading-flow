import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { computeScalars, computeSeries } from "./compute";
import { volumeMetadata } from "./metadata";
import {
  detectorFragment as detectorPromptFragment,
  featuredFewShotExample,
  reviewerFragment as reviewerPromptFragment,
} from "./promptFragments";

export const volumePlugin: IndicatorPlugin = {
  ...volumeMetadata,
  computeScalars,
  computeScalarHistory: (candles, _params, n) => {
    if (n <= 0) return { volume: [], volumeMa20: [] };
    const s = computeSeries(candles);
    // `volume` is the raw candle field — never null by construction (Zod's
    // CandleSchema declares `.nonnegative()` and the fetchers fill 0 for
    // missing). `volumeMa20` is null for the first 19 bars (rolling-MA
    // warmup) — `formatScalarHistory` renders those as "—".
    return {
      volume: candles.slice(-n).map((c) => c.volume),
      volumeMa20: s.volumeMa20.slice(-n),
    };
  },
  computeSeries: (c) => {
    // Some data sources (Yahoo forex pairs) ship volume=0 on every candle.
    // Rendering an empty histogram + flat MA line wastes pane real-estate
    // and confuses the LLM ("is there data here ?"). Return an empty
    // compound so TradingViewChart / Playwright skip this indicator
    // entirely.
    if (!c.some((candle) => candle.volume > 0)) {
      return { kind: "compound", parts: [] };
    }
    const s = computeSeries(c);
    return {
      kind: "compound",
      parts: [
        {
          kind: "histogram",
          values: c.map((candle) => ({
            value: candle.volume,
            color:
              candle.close >= candle.open ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
          })),
        },
        { kind: "lines", series: { volumeMa20: s.volumeMa20 } },
      ],
    };
  },
  scalarSchemaFragment: () => ({
    volumeMa20: z.number().nonnegative(),
    lastVolume: z.number().nonnegative(),
    volumePercentile200: z.number().min(0).max(100),
  }),
  chartPane: "secondary",
  secondaryPaneStretch: 13,
  renderConfig: {
    pane: "secondary",
    palette: ["#94a3b8", "#ab47bc"],
    secondaryPaneStretch: 13,
    seriesLabels: { histogram: "Volume", volumeMa20: "Vol MA20" },
  },
  detectorPromptFragment,
  reviewerPromptFragment,
  featuredFewShotExample,
  breakdownAxes: ["volume"],
  preFilterCriterion: "volume_spike_min",
};
