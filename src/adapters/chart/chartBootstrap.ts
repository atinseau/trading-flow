import type { IChartApi, ISeriesApi } from "lightweight-charts";
import { computeRightOffset } from "./computeRightOffset";

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

export function applyRightOffset(
  chart: IChartApi,
  density: { priceOverlayLineCount: number; priceLineCount: number },
): void {
  const offset = computeRightOffset(density);
  chart.timeScale().applyOptions({ rightOffset: offset });
}
