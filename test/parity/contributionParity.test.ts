import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyContribution } from "@adapters/chart/contributionRenderer";
import { REGISTRY } from "@adapters/indicators/IndicatorRegistry";
import fixture from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import type { UTCTimestamp } from "lightweight-charts";

type Call = { method: string; args: unknown[] };

function fakeChart(calls: Call[]) {
  const fakeMain = {
    createPriceLine: (o: unknown) => {
      calls.push({ method: "createPriceLine", args: [o] });
      return { __pl: true };
    },
    removePriceLine: () => undefined,
    attachPrimitive: (p: unknown) => {
      // Capture constructor name + bands count to detect primitive parity drift.
      const meta = {
        constructor: (p as { constructor?: { name?: string } }).constructor?.name,
        bandsCount: (p as { bands?: unknown[] }).bands?.length,
      };
      calls.push({ method: "attachPrimitive", args: [meta] });
    },
    detachPrimitive: () => undefined,
    priceToCoordinate: (n: number) => n,
  };
  return {
    chart: {
      addSeries: (cls: unknown, opts: unknown, paneIdx: unknown) => {
        calls.push({ method: "addSeries", args: [cls, opts, paneIdx] });
        return {
          setData: (d: unknown) =>
            calls.push({ method: "setData", args: [(d as unknown[]).length] }),
        };
      },
      removeSeries: () => undefined,
      panes: () => [{}],
    },
    main: fakeMain,
  };
}

const candlesForCompute = fixture.map((c) => ({
  timestamp: new Date(c.time * 1000),
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: c.volume,
}));
const candleTimes = fixture.map((c) => c.time as UTCTimestamp);

describe("contributionParity — applyContribution emits identical call sequences per plugin", () => {
  beforeEach(() => {
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = {
      LineSeries: "LineSeries",
      HistogramSeries: "HistogramSeries",
    };
  });
  afterEach(() => {
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = undefined;
  });

  for (const plugin of REGISTRY) {
    test(`${plugin.id} emits identical sequences on two invocations`, () => {
      // biome-ignore lint/suspicious/noExplicitAny: bypass strict Candle typing for the cross-plugin fixture
      const contribution = plugin.computeSeries(candlesForCompute as any);

      const callsA: Call[] = [];
      const a = fakeChart(callsA);
      applyContribution(a.chart as never, contribution, {
        id: plugin.id,
        renderConfig: plugin.renderConfig,
        paneIndex: 0,
        candleTimes,
        mainSeries: a.main as never,
        markerBucket: [],
      });

      const callsB: Call[] = [];
      const b = fakeChart(callsB);
      applyContribution(b.chart as never, contribution, {
        id: plugin.id,
        renderConfig: plugin.renderConfig,
        paneIndex: 0,
        candleTimes,
        mainSeries: b.main as never,
        markerBucket: [],
      });

      expect(callsB).toEqual(callsA);
    });
  }
});
