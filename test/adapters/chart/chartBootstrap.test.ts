import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyRightOffset, createTradingViewChart } from "@adapters/chart/chartBootstrap";

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
    (globalThis as { LightweightCharts: unknown }).LightweightCharts = LC;
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
    (globalThis as { LightweightCharts: unknown }).LightweightCharts = LC;
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
    (globalThis as { LightweightCharts: unknown }).LightweightCharts = LC;
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

describe("applyRightOffset", () => {
  test("forwards count to chart.timeScale().applyOptions({rightOffset})", () => {
    const calls: Call[] = [];
    const fakeChart = {
      timeScale: () => ({
        applyOptions: (opts: unknown) => calls.push({ method: "applyOptions", args: [opts] }),
      }),
    } as unknown as Parameters<typeof applyRightOffset>[0];
    applyRightOffset(fakeChart, { priceOverlayLineCount: 11, priceLineCount: 0 });
    expect(calls[0]).toEqual({ method: "applyOptions", args: [{ rightOffset: 12 }] });
  });
});
