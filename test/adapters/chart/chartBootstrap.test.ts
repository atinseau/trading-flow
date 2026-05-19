import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyChartRange,
  applyRightOffset,
  computeRightPadCandles,
  createTradingViewChart,
} from "@adapters/chart/chartBootstrap";

type Call = { method: string; args: unknown[] };

function fakeLC() {
  const calls: Call[] = [];
  const fakeChart = {
    addSeries: (cls: unknown, opts: unknown, paneIdx: unknown) => {
      calls.push({ method: "addSeries", args: [cls, opts, paneIdx] });
      return { __series: true };
    },
    timeScale: () => ({
      applyOptions: (opts: unknown) =>
        calls.push({ method: "timeScale.applyOptions", args: [opts] }),
      fitContent: () => calls.push({ method: "timeScale.fitContent", args: [] }),
    }),
    panes: () => [
      {
        setStretchFactor: (n: number) =>
          calls.push({ method: "pane0.setStretchFactor", args: [n] }),
      },
    ],
    applyOptions: (opts: unknown) => calls.push({ method: "applyOptions", args: [opts] }),
    remove: () => calls.push({ method: "remove", args: [] }),
  };
  return {
    LC: {
      CandlestickSeries: "CandlestickSeries",
      createChart: (_el: unknown, opts: unknown) => {
        calls.push({ method: "createChart", args: [opts] });
        return fakeChart;
      },
    },
    calls,
    fakeChart,
  };
}

describe("createTradingViewChart", () => {
  let savedLC: unknown;
  beforeEach(() => {
    savedLC = (globalThis as { LightweightCharts?: unknown }).LightweightCharts;
  });
  afterEach(() => {
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = savedLC;
  });

  test("naked: lighter grid + visible candle border + lastValueVisible", () => {
    const { LC, calls } = fakeLC();
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = LC;
    const container = { clientWidth: 800 } as unknown as HTMLDivElement;
    const { dispose } = createTradingViewChart(container, { width: 800, height: 500, naked: true });
    const createCall = calls.find((c) => c.method === "createChart")?.args[0] as {
      grid: { vertLines: { color: string } };
    };
    expect(createCall.grid.vertLines.color).toBe("#1f2330");
    const addCall = calls.find((c) => c.method === "addSeries")?.args[1] as {
      borderVisible: boolean;
      lastValueVisible: boolean;
    };
    expect(addCall.borderVisible).toBe(true);
    expect(addCall.lastValueVisible).toBe(true);
    dispose();
    expect(calls.some((c) => c.method === "remove")).toBe(true);
  });

  test("non-naked: standard grid + hidden border", () => {
    const { LC, calls } = fakeLC();
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = LC;
    const container = {} as unknown as HTMLDivElement;
    createTradingViewChart(container, { width: 800, height: 500, naked: false });
    const createCall = calls.find((c) => c.method === "createChart")?.args[0] as {
      grid: { vertLines: { color: string } };
    };
    expect(createCall.grid.vertLines.color).toBe("#2a2e39");
    const addCall = calls.find((c) => c.method === "addSeries")?.args[1] as {
      borderVisible: boolean;
    };
    expect(addCall.borderVisible).toBe(false);
  });

  test("uses canonical candle palette #26a69a / #ef5350", () => {
    const { LC, calls } = fakeLC();
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = LC;
    createTradingViewChart({} as HTMLDivElement, { width: 800, height: 500, naked: false });
    const addCall = calls.find((c) => c.method === "addSeries")?.args[1] as {
      upColor: string;
      downColor: string;
    };
    expect(addCall.upColor).toBe("#26a69a");
    expect(addCall.downColor).toBe("#ef5350");
  });

  test("throws explicit error if LightweightCharts global is missing", () => {
    delete (globalThis as { LightweightCharts?: unknown }).LightweightCharts;
    expect(() =>
      createTradingViewChart({} as HTMLDivElement, { width: 800, height: 500, naked: false }),
    ).toThrow(/setupLightweightChartsGlobal/);
  });
});

describe("computeRightPadCandles", () => {
  test("no chips → 1 candle of breathing room only", () => {
    expect(
      computeRightPadCandles(
        {
          density: { priceOverlayLineCount: 0, priceLineCount: 0 },
          maxLabelTextLength: 0,
        },
        { widthPx: 1280, candleCount: 200 },
      ),
    ).toBe(1);
  });

  test("short labels (Bollinger 'BB mid', 6 chars) → narrow strip", () => {
    // chipWidthPx = (6 + 11) × 6.5 = 110.5
    // 1280 / 200 = 6.4 px/candle → ceil(110.5/6.4) = 18
    expect(
      computeRightPadCandles(
        {
          density: { priceOverlayLineCount: 3, priceLineCount: 0 },
          maxLabelTextLength: 6,
        },
        { widthPx: 1280, candleCount: 200 },
      ),
    ).toBe(18);
  });

  test("long labels ('Fib anchor H', 12 chars) → wider strip", () => {
    // chipWidthPx = (12 + 11) × 6.5 = 149.5
    // 1280 / 200 = 6.4 px/candle → ceil(149.5/6.4) = 24
    expect(
      computeRightPadCandles(
        {
          density: { priceOverlayLineCount: 11, priceLineCount: 0 },
          maxLabelTextLength: 12,
        },
        { widthPx: 1280, candleCount: 200 },
      ),
    ).toBe(24);
  });

  test("fat candles + 1 short chip → fewer candles needed", () => {
    // chipWidthPx = (5 + 11) × 6.5 = 104
    // 1280 / 50 = 25.6 px/candle → ceil(104/25.6) = 5
    expect(
      computeRightPadCandles(
        {
          density: { priceOverlayLineCount: 1, priceLineCount: 0 },
          maxLabelTextLength: 5,
        },
        { widthPx: 1280, candleCount: 50 },
      ),
    ).toBe(5);
  });
});

describe("applyRightOffset (interactive variant)", () => {
  test("sets rightOffset only — does NOT touch visible range", () => {
    const calls: Call[] = [];
    const chart = {
      timeScale: () => ({
        applyOptions: (opts: unknown) => calls.push({ method: "applyOptions", args: [opts] }),
        setVisibleLogicalRange: (r: unknown) =>
          calls.push({ method: "setVisibleLogicalRange", args: [r] }),
      }),
    } as unknown as Parameters<typeof applyRightOffset>[0];
    applyRightOffset(
      chart,
      {
        density: { priceOverlayLineCount: 11, priceLineCount: 0 },
        maxLabelTextLength: 12,
      },
      { widthPx: 1280, candleCount: 200 },
    );
    // chipWidthPx = (12 + 11) × 6.5 = 149.5 ; 1280/200 = 6.4 ; ceil(149.5/6.4) = 24
    expect(calls).toEqual([{ method: "applyOptions", args: [{ rightOffset: 24 }] }]);
  });
});

describe("applyChartRange", () => {
  test("sets rightOffset=0 and a visible range that includes both pads", () => {
    const calls: Call[] = [];
    const chart = {
      timeScale: () => ({
        applyOptions: (opts: unknown) => calls.push({ method: "applyOptions", args: [opts] }),
        setVisibleLogicalRange: (r: unknown) =>
          calls.push({ method: "setVisibleLogicalRange", args: [r] }),
      }),
    } as unknown as Parameters<typeof applyChartRange>[0];
    applyChartRange(chart, { candleCount: 200, leftPad: 3, rightPad: 35 });
    expect(calls[0]).toEqual({ method: "applyOptions", args: [{ rightOffset: 0 }] });
    expect(calls[1]).toEqual({
      method: "setVisibleLogicalRange",
      args: [{ from: -3.5, to: 234.5 }],
    });
  });
});
