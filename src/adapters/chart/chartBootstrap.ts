import type { IChartApi, ISeriesApi } from "lightweight-charts";

export type ChartCandleStyle = {
  upColor: string;
  downColor: string;
  borderVisible: boolean;
  wickUpColor: string;
  wickDownColor: string;
  lastValueVisible: boolean;
};

export type ChartBootstrapOpts = {
  width: number;
  height: number;
  /** Naked = no indicators ; lighter grid, candle border visible. */
  naked: boolean;
  /** Override candle styling — defaults to the canonical candle palette
   *  (`#26a69a` / `#ef5350`). Indicator colors live in each plugin's
   *  `renderConfig`, not here. */
  styleOverrides?: Partial<ChartCandleStyle>;
};

export type ChartBootstrapResult = {
  chart: IChartApi;
  candleSeries: ISeriesApi<"Candlestick">;
  dispose(): void;
};

const CANONICAL_CANDLE_STYLE: ChartCandleStyle = {
  upColor: "#26a69a",
  downColor: "#ef5350",
  borderVisible: false,
  wickUpColor: "#26a69a",
  wickDownColor: "#ef5350",
  lastValueVisible: false,
};

function readLC(): {
  createChart: (el: HTMLDivElement, opts: unknown) => IChartApi;
  CandlestickSeries: unknown;
} {
  const lc = (globalThis as { LightweightCharts?: unknown }).LightweightCharts;
  if (!lc) {
    throw new Error(
      "[chartBootstrap] globalThis.LightweightCharts is undefined. " +
        "Frontend : import `@client/lib/setupLightweightChartsGlobal` once at boot. " +
        "Backend Playwright : ensure the standalone bundle is injected before invoking the renderer.",
    );
  }
  return lc as {
    createChart: (el: HTMLDivElement, opts: unknown) => IChartApi;
    CandlestickSeries: unknown;
  };
}

export function createTradingViewChart(
  container: HTMLDivElement,
  opts: ChartBootstrapOpts,
): ChartBootstrapResult {
  const LC = readLC();
  const style = { ...CANONICAL_CANDLE_STYLE, ...opts.styleOverrides };
  if (opts.naked) {
    style.borderVisible = true;
    style.lastValueVisible = true;
  }
  const chart = LC.createChart(container, {
    width: opts.width,
    height: opts.height,
    layout: {
      background: { color: "#131722" },
      textColor: "#d1d4dc",
      panes: { separatorColor: "#2a2e39", separatorHoverColor: "#363a45" },
    },
    grid: {
      vertLines: { color: opts.naked ? "#1f2330" : "#2a2e39" },
      horzLines: { color: "#2a2e39" },
    },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#485158" },
    rightPriceScale: { borderColor: "#485158" },
    crosshair: { mode: 0 },
  });
  const candleSeries = chart.addSeries(
    LC.CandlestickSeries as never,
    style,
    0,
  ) as ISeriesApi<"Candlestick">;
  return {
    chart,
    candleSeries,
    dispose: () => chart.remove(),
  };
}

/** Average logical px per character at lightweight-charts' default chip font
 *  (12 px Trebuchet MS). Empirical — measured against rendered output. */
const CHAR_WIDTH_PX = 6.5;

/** Reserved chars on top of the title : the price value (`"76675.76"` ≈ 8
 *  chars) + chip padding + separator gap. */
const VALUE_AND_PADDING_CHARS = 11;

export function computeRightPadCandles(
  opts: {
    density: { priceOverlayLineCount: number; priceLineCount: number };
    /** Character count of the longest chip title that will render (see
     *  `maxAxisLabelLength`). Pass 0 for naked charts. */
    maxLabelTextLength: number;
  },
  viewport: { widthPx: number; candleCount: number },
): number {
  // No chips → no label strip → just one candle of breathing room.
  const totalLabels = opts.density.priceOverlayLineCount + opts.density.priceLineCount;
  if (totalLabels === 0 || opts.maxLabelTextLength === 0) return 1;

  // Chip strip width is governed by the *longest* chip text (others stack
  // vertically at the same x). A Bollinger-only chart ("BB mid", 6 chars)
  // needs ~110 px ; a Fibonacci-only one ("Fib anchor H", 12 chars) needs
  // ~150 px. Sizing per content avoids the over-reserve we got with a
  // constant budget on cheap-chip configs.
  const chipWidthPx = (opts.maxLabelTextLength + VALUE_AND_PADDING_CHARS) * CHAR_WIDTH_PX;
  const candleWidthPx = viewport.widthPx / Math.max(1, viewport.candleCount);
  return Math.ceil(chipWidthPx / Math.max(0.5, candleWidthPx));
}

/**
 * Interactive variant — set the `rightOffset` option only, leave the visible
 * range alone so the user's scroll / zoom state survives a re-render.
 * Use in the React frontend (asset-chart, setup tv-chart, replay-chart).
 * For one-shot server renders (PlaywrightChartRenderer), prefer
 * `applyChartRange` which bakes both pads into an explicit range.
 */
export function applyRightOffset(
  chart: IChartApi,
  opts: {
    density: { priceOverlayLineCount: number; priceLineCount: number };
    maxLabelTextLength: number;
  },
  viewport: { widthPx: number; candleCount: number },
): void {
  const offset = computeRightPadCandles(opts, viewport);
  chart.timeScale().applyOptions({ rightOffset: offset });
}

/**
 * Drive the chart's visible logical range explicitly. Replaces the older
 * `applyRightOffset` + `fitContent` + `applyLeftPadding` triple, which had a
 * silent failure : `setVisibleLogicalRange` ignores the `rightOffset` option,
 * so re-applying the range (for left padding) wiped the right offset and the
 * chips bled back into the last candles.
 *
 * We bake both pads into the range and set `rightOffset: 0` so there's a
 * single source of truth.
 */
export function applyChartRange(
  chart: IChartApi,
  opts: { candleCount: number; leftPad: number; rightPad: number },
): void {
  chart.timeScale().applyOptions({ rightOffset: 0 });
  chart.timeScale().setVisibleLogicalRange({
    from: -opts.leftPad - 0.5,
    to: opts.candleCount - 0.5 + opts.rightPad,
  });
}
