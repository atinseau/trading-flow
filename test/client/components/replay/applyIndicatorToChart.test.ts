import { describe, expect, test } from "bun:test";
import {
  alignToTimes,
  applyIndicatorToChart,
} from "@client/components/replay/applyIndicatorToChart";
import { HistogramSeries, LineSeries, type UTCTimestamp } from "lightweight-charts";

/**
 * The dispatcher only cares about which chart methods get called and
 * what shape of data is fed into them — easy to assert against a mock.
 *
 * We don't go as far as testing the chart's internal rendering ; that's
 * `lightweight-charts`' job. We DO test :
 *  - one `addSeries(Line)` per named series in a `lines` contribution
 *  - `createPriceLine` is called once per entry of a `priceLines` contrib
 *  - `markers` push into the shared bucket (no chart side-effect)
 *  - `histogram` calls `addSeries(Histogram)` once
 *  - `compound` recurses
 *  - cleanup removes everything (and only what was created)
 */

function mockChart() {
  // We tag each addSeries call with the constructor reference itself, so
  // assertions can compare against the imported LineSeries / HistogramSeries
  // symbols rather than relying on .name (which is empty on the v5 builders).
  const created: { ctor: unknown; opts: unknown; paneIndex?: number }[] = [];
  let priceLineCount = 0;
  const removedSeries: { ctor: unknown }[] = [];
  const removedPriceLines: number[] = [];

  const fakeMainSeries = {
    createPriceLine: (_opts: unknown) => {
      priceLineCount += 1;
      const id = priceLineCount;
      return {
        __id: id,
        applyOptions: () => undefined,
      };
    },
    removePriceLine: (line: unknown) => {
      removedPriceLines.push((line as { __id: number }).__id);
    },
    setData: () => undefined,
  } as unknown as Parameters<typeof applyIndicatorToChart>[2]["mainSeries"];

  const fakeChart = {
    panes: () => [{}], // start with 1 pane (the main one)
    addSeries: (ctor: unknown, opts: unknown, paneIndex?: number) => {
      created.push({ ctor, opts, paneIndex });
      return {
        setData: () => undefined,
        applyOptions: () => undefined,
        __ctor: ctor,
      };
    },
    removeSeries: (s: unknown) => {
      removedSeries.push({ ctor: (s as { __ctor: unknown }).__ctor });
    },
  } as unknown as Parameters<typeof applyIndicatorToChart>[0];

  return {
    fakeChart,
    fakeMainSeries,
    created,
    removedSeries,
    removedPriceLines,
    priceLineCountRef: { get: () => priceLineCount },
  };
}

const TIMES: UTCTimestamp[] = [1000, 1900, 2800, 3700, 4600] as UTCTimestamp[];

describe("applyIndicatorToChart — lines", () => {
  test("one LineSeries per named series, on main pane for price_overlay", () => {
    const { fakeChart, fakeMainSeries, created } = mockChart();
    const markerBucket: import("lightweight-charts").SeriesMarker<
      import("lightweight-charts").Time
    >[] = [];
    applyIndicatorToChart(
      fakeChart,
      {
        kind: "lines",
        series: {
          emaShort: [1, 2, 3, 4, 5],
          emaMid: [1, 2, 3, 4, 5],
          emaLong: [1, 2, 3, 4, 5],
        },
      },
      {
        id: "ema_stack",
        pane: "price_overlay",
        candleTimes: TIMES,
        mainSeries: fakeMainSeries,
        markerBucket,
        colorPalette: ["#10b981", "#f59e0b", "#ef4444"],
      },
    );
    expect(created.length).toBe(3);
    // All three on the main pane (index 0).
    for (const c of created) expect(c.paneIndex).toBe(0);
  });

  test("secondary indicators (RSI) target a NEW pane index", () => {
    const { fakeChart, fakeMainSeries, created } = mockChart();
    const markerBucket: import("lightweight-charts").SeriesMarker<
      import("lightweight-charts").Time
    >[] = [];
    applyIndicatorToChart(
      fakeChart,
      { kind: "lines", series: { rsi: [50, 55, 60, 65, 70] } },
      {
        id: "rsi",
        pane: "secondary",
        candleTimes: TIMES,
        mainSeries: fakeMainSeries,
        markerBucket,
        colorPalette: ["#3b82f6"],
      },
    );
    expect(created.length).toBe(1);
    expect(created[0]?.paneIndex).toBe(1); // panes()=[{main}] → next available is 1.
  });
});

describe("applyIndicatorToChart — priceLines", () => {
  test("createPriceLine called once per entry", () => {
    const { fakeChart, fakeMainSeries, priceLineCountRef } = mockChart();
    const markerBucket: import("lightweight-charts").SeriesMarker<
      import("lightweight-charts").Time
    >[] = [];
    applyIndicatorToChart(
      fakeChart,
      {
        kind: "priceLines",
        lines: [
          { price: 80950, color: "#9ca3af", style: 2, title: "Invalidation" },
          { price: 80700, color: "#9ca3af", style: 2, title: "POC" },
          { price: 80100, color: "#9ca3af", style: 2, title: "HH" },
        ],
      },
      {
        id: "structure_levels",
        pane: "price_overlay",
        candleTimes: TIMES,
        mainSeries: fakeMainSeries,
        markerBucket,
        colorPalette: [],
      },
    );
    expect(priceLineCountRef.get()).toBe(3);
  });
});

describe("applyIndicatorToChart — markers", () => {
  test("markers pushed into the shared bucket; no chart side effect", () => {
    const { fakeChart, fakeMainSeries, created } = mockChart();
    const markerBucket: import("lightweight-charts").SeriesMarker<
      import("lightweight-charts").Time
    >[] = [];
    applyIndicatorToChart(
      fakeChart,
      {
        kind: "markers",
        markers: [
          { index: 1, position: "above", text: "HH", color: "#10b981", shape: "arrowDown" },
          { index: 3, position: "below", text: "LL", color: "#ef4444", shape: "arrowUp" },
        ],
      },
      {
        id: "swings_bos",
        pane: "price_overlay",
        candleTimes: TIMES,
        mainSeries: fakeMainSeries,
        markerBucket,
        colorPalette: [],
      },
    );
    expect(created.length).toBe(0);
    expect(markerBucket.length).toBe(2);
    expect(markerBucket[0]?.position).toBe("aboveBar");
    expect(markerBucket[1]?.position).toBe("belowBar");
    expect(markerBucket[0]?.time).toBe(TIMES[1]);
    expect(markerBucket[1]?.time).toBe(TIMES[3]);
  });

  test("markers with out-of-bounds index are skipped", () => {
    const { fakeChart, fakeMainSeries } = mockChart();
    const markerBucket: import("lightweight-charts").SeriesMarker<
      import("lightweight-charts").Time
    >[] = [];
    applyIndicatorToChart(
      fakeChart,
      {
        kind: "markers",
        markers: [
          { index: 1, position: "above", text: "ok", color: "#10b981", shape: "circle" },
          { index: 99, position: "above", text: "bad", color: "#ef4444", shape: "circle" },
        ],
      },
      {
        id: "test",
        pane: "price_overlay",
        candleTimes: TIMES,
        mainSeries: fakeMainSeries,
        markerBucket,
        colorPalette: [],
      },
    );
    expect(markerBucket.length).toBe(1);
  });
});

describe("applyIndicatorToChart — histogram", () => {
  test("one HistogramSeries in a new pane", () => {
    const { fakeChart, fakeMainSeries, created } = mockChart();
    const markerBucket: import("lightweight-charts").SeriesMarker<
      import("lightweight-charts").Time
    >[] = [];
    applyIndicatorToChart(
      fakeChart,
      {
        kind: "histogram",
        values: [100, 150, null, { value: 200, color: "#ef4444" }, 250],
      },
      {
        id: "volume",
        pane: "secondary",
        candleTimes: TIMES,
        mainSeries: fakeMainSeries,
        markerBucket,
        colorPalette: ["#3b82f6"],
      },
    );
    expect(created.length).toBe(1);
    expect(created[0]?.ctor).toBe(HistogramSeries);
    expect(created[0]?.paneIndex).toBe(1);
  });
});

describe("applyIndicatorToChart — line series use LineSeries constructor", () => {
  test("each entry in `lines` calls addSeries with LineSeries", () => {
    const { fakeChart, fakeMainSeries, created } = mockChart();
    const markerBucket: import("lightweight-charts").SeriesMarker<
      import("lightweight-charts").Time
    >[] = [];
    applyIndicatorToChart(
      fakeChart,
      { kind: "lines", series: { foo: [1, 2, 3, 4, 5] } },
      {
        id: "t",
        pane: "price_overlay",
        candleTimes: TIMES,
        mainSeries: fakeMainSeries,
        markerBucket,
        colorPalette: ["#000"],
      },
    );
    expect(created[0]?.ctor).toBe(LineSeries);
  });
});

describe("applyIndicatorToChart — compound", () => {
  test("recurses through every part", () => {
    const { fakeChart, fakeMainSeries, created, priceLineCountRef } = mockChart();
    const markerBucket: import("lightweight-charts").SeriesMarker<
      import("lightweight-charts").Time
    >[] = [];
    applyIndicatorToChart(
      fakeChart,
      {
        kind: "compound",
        parts: [
          { kind: "lines", series: { signal: [1, 2, 3, 4, 5] } },
          {
            kind: "priceLines",
            lines: [{ price: 100, color: "#000", style: 2, title: "x" }],
          },
        ],
      },
      {
        id: "macd",
        pane: "price_overlay",
        candleTimes: TIMES,
        mainSeries: fakeMainSeries,
        markerBucket,
        colorPalette: ["#3b82f6"],
      },
    );
    expect(created.length).toBe(1); // one line series
    expect(priceLineCountRef.get()).toBe(1);
  });
});

describe("applyIndicatorToChart — cleanup", () => {
  test("removes the line series + price lines it created", () => {
    const { fakeChart, fakeMainSeries, created, removedSeries, removedPriceLines } = mockChart();
    const markerBucket: import("lightweight-charts").SeriesMarker<
      import("lightweight-charts").Time
    >[] = [];
    const { cleanup } = applyIndicatorToChart(
      fakeChart,
      {
        kind: "compound",
        parts: [
          { kind: "lines", series: { a: [1, 2, 3, 4, 5], b: [1, 2, 3, 4, 5] } },
          {
            kind: "priceLines",
            lines: [
              { price: 100, color: "#000", style: 2, title: "x" },
              { price: 200, color: "#000", style: 2, title: "y" },
            ],
          },
        ],
      },
      {
        id: "test",
        pane: "price_overlay",
        candleTimes: TIMES,
        mainSeries: fakeMainSeries,
        markerBucket,
        colorPalette: ["#000", "#111"],
      },
    );
    expect(created.length).toBe(2);
    cleanup();
    expect(removedSeries.length).toBe(2);
    expect(removedPriceLines.length).toBe(2);
  });
});

describe("alignToTimes", () => {
  test("skips nulls and undefined", () => {
    const times = [10, 20, 30, 40] as UTCTimestamp[];
    expect(alignToTimes(times, [1, null, 3, 4])).toEqual([
      { time: 10 as UTCTimestamp, value: 1 },
      { time: 30 as UTCTimestamp, value: 3 },
      { time: 40 as UTCTimestamp, value: 4 },
    ]);
  });

  test("stops at shorter of the two arrays", () => {
    const times = [10, 20] as UTCTimestamp[];
    expect(alignToTimes(times, [1, 2, 3, 4]).length).toBe(2);
  });
});
