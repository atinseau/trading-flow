import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { computeAnchor, computeScalars, fibLevels } from "./compute";
import { fibonacciMetadata } from "./metadata";
import { detectorFragment, reviewerFragment } from "./promptFragments";

const FIBONACCI_PARAMS_SCHEMA = z.object({ lookback: z.number().int().min(1).max(10) }).strict();

const COLOR_GOLDEN = "#f59e0b"; // amber for 0.618 golden zone
const COLOR_MID = "#10b981"; // emerald for 0.5
const COLOR_SHALLOW = "#3b82f6"; // blue for 0.382
const COLOR_EXTENSION = "#ef4444"; // red for 1.272/1.618
const COLOR_ANCHOR = "#94a3b8"; // slate for anchor high/low
const BAND_ALPHA = "0.15";

export const fibonacciPlugin: IndicatorPlugin = {
  ...fibonacciMetadata,
  computeScalars,
  computeSeries: (candles, params) => {
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const lb = (params?.lookback as number | undefined) ?? 3;
    const anchor = computeAnchor(highs, lows, lb);
    if (!anchor) {
      return { kind: "compound", parts: [] };
    }
    const lv = fibLevels(anchor);
    // PriceLines : anchor + 5 Fib levels (7 lines total).
    const priceLines = [
      { price: anchor.high, color: COLOR_ANCHOR, style: 0 as 0 | 1 | 2, title: "Fib anchor H" },
      { price: anchor.low, color: COLOR_ANCHOR, style: 0 as 0 | 1 | 2, title: "Fib anchor L" },
      { price: lv.fib_0_382, color: COLOR_SHALLOW, style: 2 as 0 | 1 | 2, title: "Fib 0.382" },
      { price: lv.fib_0_500, color: COLOR_MID, style: 2 as 0 | 1 | 2, title: "Fib 0.500" },
      { price: lv.fib_0_618, color: COLOR_GOLDEN, style: 2 as 0 | 1 | 2, title: "Fib 0.618" },
      { price: lv.fib_1_272, color: COLOR_EXTENSION, style: 1 as 0 | 1 | 2, title: "Fib 1.272" },
      { price: lv.fib_1_618, color: COLOR_EXTENSION, style: 1 as 0 | 1 | 2, title: "Fib 1.618" },
    ];
    // Bands : 4 retracement zones. Sort by price desc so top→bottom stack reads correctly.
    const sorted = [anchor.high, anchor.low, lv.fib_0_382, lv.fib_0_500, lv.fib_0_618]
      .slice()
      .sort((a, b) => b - a);
    // Adjacent-pair bands. Color the 0.5↔0.618 band as the golden zone.
    const bands = [
      {
        topPrice: sorted[0] as number,
        bottomPrice: sorted[1] as number,
        fillColor: `rgba(59, 130, 246, ${BAND_ALPHA})`,
        label: "shallow",
      },
      {
        topPrice: sorted[1] as number,
        bottomPrice: sorted[2] as number,
        fillColor: `rgba(16, 185, 129, ${BAND_ALPHA})`,
        label: "mid",
      },
      {
        topPrice: sorted[2] as number,
        bottomPrice: sorted[3] as number,
        fillColor: `rgba(245, 158, 11, 0.2)`,
        label: "golden zone",
      },
      {
        topPrice: sorted[3] as number,
        bottomPrice: sorted[4] as number,
        fillColor: `rgba(239, 68, 68, ${BAND_ALPHA})`,
        label: "deep",
      },
    ];
    // Markers : Swing H/L on the anchor candles.
    const markers = [
      {
        index: anchor.highIdx,
        position: "above" as const,
        color: "#ef5350",
        shape: "arrowDown" as const,
        text: "SH",
      },
      {
        index: anchor.lowIdx,
        position: "below" as const,
        color: "#26a69a",
        shape: "arrowUp" as const,
        text: "SL",
      },
    ];
    return {
      kind: "compound",
      parts: [
        { kind: "priceLines", lines: priceLines },
        { kind: "bands", bands },
        { kind: "markers", markers },
      ],
    };
  },
  scalarSchemaFragment: () => ({
    fibAnchorHigh: z.number().nullable(),
    fibAnchorLow: z.number().nullable(),
    fibDirection: z.enum(["uptrend", "downtrend"]).nullable(),
    fib_0_382: z.number().nullable(),
    fib_0_500: z.number().nullable(),
    fib_0_618: z.number().nullable(),
    fib_1_272: z.number().nullable(),
    fib_1_618: z.number().nullable(),
  }),
  chartPane: "price_overlay",
  renderConfig: {
    pane: "price_overlay",
    palette: [COLOR_GOLDEN, COLOR_MID, COLOR_SHALLOW, COLOR_EXTENSION, COLOR_ANCHOR],
    seriesLabels: {
      "Fib 0.382": "Fib 0.382",
      "Fib 0.500": "Fib 0.500",
      "Fib 0.618": "Fib 0.618 (golden)",
      "Fib 1.272": "Fib 1.272",
      "Fib 1.618": "Fib 1.618",
    },
  },
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  breakdownAxes: ["structure"],
  paramsSchema: FIBONACCI_PARAMS_SCHEMA,
};
