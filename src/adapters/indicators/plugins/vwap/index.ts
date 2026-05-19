import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { computeScalars, computeSeries } from "./compute";
import { vwapMetadata } from "./metadata";
import { detectorFragment, reviewerFragment } from "./promptFragments";

export const vwapPlugin: IndicatorPlugin = {
  ...vwapMetadata,
  computeScalars,
  computeScalarHistory: (candles, _params, n) => {
    if (n <= 0) return { vwap: [] };
    if (!candles.some((c) => c.volume > 0)) return { vwap: [] };
    const series = computeSeries(candles);
    return { vwap: series.vwap.slice(-n) };
  },
  // VWAP needs volume to be meaningful — on a zero-volume feed (Yahoo
  // forex) the weighted average degenerates to the unweighted average,
  // visually a flat dotted line indistinguishable from the last-price
  // line. Drop the rendering when no candle carries volume.
  computeSeries: (c) => {
    if (!c.some((candle) => candle.volume > 0)) {
      return { kind: "compound", parts: [] };
    }
    return { kind: "lines", series: computeSeries(c) };
  },
  scalarSchemaFragment: () => ({ vwapSession: z.number(), priceVsVwapPct: z.number() }),
  chartPane: "price_overlay",
  renderConfig: {
    pane: "price_overlay",
    palette: ["#10b981"],
    // computeSeries returns `{ vwapSession: ... }` — the seriesLabels key
    // must match. Was previously named "vwap" which fell back to
    // `vwap:vwapSession` literal in the legend.
    seriesLabels: { vwap: "VWAP" },
  },
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
};
