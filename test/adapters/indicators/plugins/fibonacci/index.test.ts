import { describe, expect, test } from "bun:test";
import { fibonacciPlugin } from "@adapters/indicators/plugins/fibonacci";

function makeCandles() {
  const arr: Array<{
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  for (let i = 0; i < 8; i++)
    arr.push({
      timestamp: new Date(Date.UTC(2026, 0, 1, i)),
      open: 100 - i,
      high: 100 - i,
      low: 99 - i,
      close: 99.5 - i,
      volume: 1000,
    });
  arr.push({
    timestamp: new Date(Date.UTC(2026, 0, 1, 8)),
    open: 91.5,
    high: 92.5,
    low: 91,
    close: 92,
    volume: 1000,
  });
  for (let i = 0; i < 7; i++)
    arr.push({
      timestamp: new Date(Date.UTC(2026, 0, 1, 9 + i)),
      open: 92 + i * 1.5,
      high: 93 + i * 2,
      low: 92 + i * 0.8,
      close: 92.5 + i * 1.5,
      volume: 1000,
    });
  arr.push({
    timestamp: new Date(Date.UTC(2026, 0, 1, 16)),
    open: 105,
    high: 108,
    low: 100,
    close: 106,
    volume: 1000,
  });
  for (let i = 0; i < 5; i++)
    arr.push({
      timestamp: new Date(Date.UTC(2026, 0, 1, 17 + i)),
      open: 106 - i,
      high: 106 - i,
      low: 100.5 + i * 0.2,
      close: 105 - i,
      volume: 1000,
    });
  return arr;
}

describe("fibonacciPlugin metadata + renderConfig", () => {
  test("id, tag, breakdownAxes, renderConfig", () => {
    expect(fibonacciPlugin.id).toBe("fibonacci");
    expect(fibonacciPlugin.tag).toBe("structure");
    expect(fibonacciPlugin.breakdownAxes).toEqual(["structure"]);
    expect(fibonacciPlugin.renderConfig.pane).toBe("price_overlay");
    expect(fibonacciPlugin.renderConfig.palette.length).toBe(5);
  });

  test("paramsSchema validates lookback range", () => {
    expect(fibonacciPlugin.paramsSchema?.parse({ lookback: 3 })).toEqual({ lookback: 3 });
    expect(() => fibonacciPlugin.paramsSchema?.parse({ lookback: 0 })).toThrow();
    expect(() => fibonacciPlugin.paramsSchema?.parse({ lookback: 11 })).toThrow();
  });
});

describe("fibonacciPlugin.computeScalars", () => {
  test("returns nullable scalars when no swing pair", () => {
    const tiny = Array.from({ length: 5 }, (_, i) => ({
      timestamp: new Date(Date.UTC(2026, 0, 1, i)),
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 1,
    }));
    const s = fibonacciPlugin.computeScalars(tiny);
    expect(s.fibAnchorHigh).toBeNull();
    expect(s.fib_0_382).toBeNull();
  });

  test("returns populated scalars for the synthetic uptrend leg", () => {
    const c = makeCandles();
    const s = fibonacciPlugin.computeScalars(c);
    expect(s.fibDirection).toBe("uptrend");
    expect(typeof s.fibAnchorHigh).toBe("number");
    expect(typeof s.fibAnchorLow).toBe("number");
    expect(typeof s.fib_0_618).toBe("number");
    // 0.618 should be below the high in an uptrend
    expect(s.fib_0_618 as number).toBeLessThan(s.fibAnchorHigh as number);
  });
});

describe("fibonacciPlugin.computeSeries", () => {
  test("returns empty compound when no anchor", () => {
    const tiny = Array.from({ length: 5 }, (_, i) => ({
      timestamp: new Date(Date.UTC(2026, 0, 1, i)),
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 1,
    }));
    const c = fibonacciPlugin.computeSeries(tiny);
    expect(c.kind).toBe("compound");
    if (c.kind !== "compound") throw new Error();
    expect(c.parts.length).toBe(0);
  });

  test("compound with priceLines + bands + markers when anchor exists", () => {
    const candles = makeCandles();
    const c = fibonacciPlugin.computeSeries(candles);
    expect(c.kind).toBe("compound");
    if (c.kind !== "compound") throw new Error();
    const priceLines = c.parts.find((p) => p.kind === "priceLines");
    const bands = c.parts.find((p) => p.kind === "bands");
    const markers = c.parts.find((p) => p.kind === "markers");
    expect(priceLines).toBeDefined();
    expect(bands).toBeDefined();
    expect(markers).toBeDefined();
    if (priceLines?.kind === "priceLines") expect(priceLines.lines.length).toBe(7);
    if (bands?.kind === "bands") expect(bands.bands.length).toBe(4);
    if (markers?.kind === "markers") expect(markers.markers.length).toBe(2);
  });
});
