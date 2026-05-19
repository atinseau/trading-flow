import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type ApplyContributionOpts,
  applyContribution,
} from "@adapters/chart/contributionRenderer";
import type { IndicatorSeriesContribution } from "@domain/charts/types";

type Call = { method: string; args: unknown[] };

function fakeChartAndSeries(calls: Call[]) {
  const fakeMain = {
    createPriceLine: (opts: unknown) => {
      calls.push({ method: "main.createPriceLine", args: [opts] });
      return { __priceLine: true };
    },
    removePriceLine: (line: unknown) =>
      calls.push({ method: "main.removePriceLine", args: [line] }),
    attachPrimitive: (p: unknown) => calls.push({ method: "main.attachPrimitive", args: [p] }),
    detachPrimitive: (p: unknown) => calls.push({ method: "main.detachPrimitive", args: [p] }),
    priceToCoordinate: (n: number) => n,
    chart: () => ({ timeScale: () => ({ timeToCoordinate: (t: number) => t }) }),
  };
  const fakeAddSeries = (cls: unknown, opts: unknown, paneIdx: unknown) => {
    calls.push({ method: "chart.addSeries", args: [cls, opts, paneIdx] });
    return {
      setData: (d: unknown) => calls.push({ method: "series.setData", args: [d] }),
      // Secondary-pane series may receive priceLines (RSI 70/30 refs etc.) —
      // the dispatcher attaches priceLines from a compound to the last
      // created line series rather than to mainSeries.
      createPriceLine: (o: unknown) => {
        calls.push({ method: "series.createPriceLine", args: [o] });
        return { __pl: true };
      },
      removePriceLine: (line: unknown) =>
        calls.push({ method: "series.removePriceLine", args: [line] }),
    };
  };
  const fakeChart = {
    addSeries: fakeAddSeries,
    removeSeries: (s: unknown) => calls.push({ method: "chart.removeSeries", args: [s] }),
    panes: () => [{}],
  };
  return { fakeChart, fakeMain };
}

function makeOpts(calls: Call[]): ApplyContributionOpts & { _chart: unknown; _main: unknown } {
  const { fakeChart, fakeMain } = fakeChartAndSeries(calls);
  return {
    id: "ema",
    renderConfig: {
      pane: "price_overlay",
      palette: ["#3b82f6", "#f59e0b", "#ef4444"],
      seriesLabels: { ema_short: "EMA short" },
    },
    paneIndex: 0,
    candleTimes: [1000, 1100, 1200] as unknown as ApplyContributionOpts["candleTimes"],
    mainSeries: fakeMain as unknown as ApplyContributionOpts["mainSeries"],
    markerBucket: [],
    _chart: fakeChart,
    _main: fakeMain,
  };
}

describe("applyContribution dispatcher", () => {
  beforeEach(() => {
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = {
      LineSeries: "LineSeries",
      HistogramSeries: "HistogramSeries",
    };
  });
  afterEach(() => {
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = undefined;
  });

  test("kind=lines → addSeries(LineSeries) once per named series with labelled title + colored from palette", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "lines",
      series: { ema_short: [1, 2, 3], ema_mid: [10, 20, 30] },
    };
    const opts = makeOpts(calls);
    applyContribution(opts._chart as never, c, opts);
    const addCalls = calls.filter((c) => c.method === "chart.addSeries");
    expect(addCalls.length).toBe(2);
    expect((addCalls[0]?.args[1] as { title: string }).title).toBe("EMA short");
    expect((addCalls[0]?.args[1] as { color: string }).color).toBe("#3b82f6");
    expect((addCalls[1]?.args[1] as { color: string }).color).toBe("#f59e0b");
    // Second-line label falls back to `<id>:<name>` when no seriesLabels mapping
    expect((addCalls[1]?.args[1] as { title: string }).title).toBe("ema:ema_mid");
  });

  test("kind=priceLines → createPriceLine on mainSeries per line", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "priceLines",
      lines: [
        { price: 100, color: "#fff", style: 0, title: "TP" },
        { price: 90, color: "#000", style: 2, title: "" },
      ],
    };
    const opts = makeOpts(calls);
    applyContribution(opts._chart as never, c, opts);
    const plCalls = calls.filter((c) => c.method === "main.createPriceLine");
    expect(plCalls.length).toBe(2);
    // axisLabelVisible should be true for the first (title non-empty) and false for the second
    expect((plCalls[0]?.args[0] as { axisLabelVisible: boolean }).axisLabelVisible).toBe(true);
    expect((plCalls[1]?.args[0] as { axisLabelVisible: boolean }).axisLabelVisible).toBe(false);
  });

  test("kind=markers → pushed into bucket with correct fields, no chart call", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "markers",
      markers: [
        { index: 0, position: "above", text: "Swing H", color: "#ef4444", shape: "arrowDown" },
        { index: 2, position: "below", text: "Swing L", color: "#10b981", shape: "arrowUp" },
      ],
    };
    const opts = makeOpts(calls);
    applyContribution(opts._chart as never, c, opts);
    expect(opts.markerBucket.length).toBe(2);
    expect(opts.markerBucket[0]?.text).toBe("Swing H");
    expect(opts.markerBucket[0]?.position).toBe("aboveBar");
    expect(opts.markerBucket[1]?.position).toBe("belowBar");
    expect(calls.filter((c) => c.method === "chart.addSeries").length).toBe(0);
  });

  test("kind=markers → markers with index past candleTimes length are skipped", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "markers",
      markers: [{ index: 999, position: "above", text: "X", color: "#fff", shape: "arrowDown" }],
    };
    const opts = makeOpts(calls);
    applyContribution(opts._chart as never, c, opts);
    expect(opts.markerBucket.length).toBe(0);
  });

  test("kind=histogram → addSeries(HistogramSeries) + setData filters nulls", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "histogram",
      values: [10, null, { value: 30, color: "red" }],
    };
    const opts = makeOpts(calls);
    applyContribution(opts._chart as never, c, opts);
    expect(calls.find((c) => c.method === "chart.addSeries")?.args[0]).toBe("HistogramSeries");
    const setDataCall = calls.find((c) => c.method === "series.setData");
    expect((setDataCall?.args[0] as unknown[]).length).toBe(2); // null filtered out
  });

  test("kind=bands → attachPrimitive on mainSeries with a BandsPrimitive instance", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "bands",
      bands: [{ topPrice: 110, bottomPrice: 100, fillColor: "rgba(255,0,0,0.2)" }],
    };
    const opts = makeOpts(calls);
    applyContribution(opts._chart as never, c, opts);
    const attachCalls = calls.filter((c) => c.method === "main.attachPrimitive");
    expect(attachCalls.length).toBe(1);
  });

  test("kind=compound → recurses into parts", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "compound",
      parts: [
        { kind: "priceLines", lines: [{ price: 100, color: "#fff", style: 0, title: "TP" }] },
        {
          kind: "markers",
          markers: [{ index: 1, position: "above", text: "X", color: "#fff", shape: "arrowUp" }],
        },
      ],
    };
    const opts = makeOpts(calls);
    applyContribution(opts._chart as never, c, opts);
    expect(calls.some((c) => c.method === "main.createPriceLine")).toBe(true);
    expect(opts.markerBucket.length).toBe(1);
  });

  test("cleanup() removes series, priceLines AND detaches primitives", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "compound",
      parts: [
        { kind: "lines", series: { ema_short: [1, 2, 3] } },
        { kind: "priceLines", lines: [{ price: 100, color: "#fff", style: 0, title: "TP" }] },
        {
          kind: "bands",
          bands: [{ topPrice: 110, bottomPrice: 100, fillColor: "rgba(255,0,0,0.2)" }],
        },
      ],
    };
    const opts = makeOpts(calls);
    const { cleanup } = applyContribution(opts._chart as never, c, opts);
    cleanup();
    expect(calls.some((c) => c.method === "chart.removeSeries")).toBe(true);
    // priceLines attached to the secondary line series (compound contains
    // both lines + priceLines, so priceLines target the just-created line).
    expect(calls.some((c) => c.method === "series.removePriceLine")).toBe(true);
    expect(calls.some((c) => c.method === "main.detachPrimitive")).toBe(true);
  });

  test("throws if globalThis.LightweightCharts is missing", () => {
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = undefined;
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = { kind: "lines", series: { x: [1] } };
    const opts = makeOpts(calls);
    expect(() => applyContribution(opts._chart as never, c, opts)).toThrow(
      /setupLightweightChartsGlobal/,
    );
  });
});
