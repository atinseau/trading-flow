import { describe, expect, test } from "bun:test";
import { structureLevelsPlugin } from "@adapters/indicators/plugins/structure_levels";
import { detectFvgs } from "@adapters/indicators/plugins/base/math";
import type { Candle } from "@domain/schemas/Candle";

const sampleCandles = Array.from({ length: 80 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 4, 1, i)),
  open: 100, high: 100 + Math.sin(i / 5),
  low: 99 - Math.sin(i / 5),
  close: 100 + Math.sin(i / 5) * 0.5, volume: 1000 + i,
}));

describe("structureLevelsPlugin", () => {
  test("metadata", () => {
    expect(structureLevelsPlugin.id).toBe("structure_levels");
    expect(structureLevelsPlugin.tag).toBe("structure");
    expect(structureLevelsPlugin.preFilterCriterion).toBe("near_pivot");
    expect(structureLevelsPlugin.breakdownAxes).toEqual(["structure"]);
  });

  test("computeScalars exposes recentHigh, recentLow, pocPrice", () => {
    const s = structureLevelsPlugin.computeScalars(sampleCandles);
    expect(typeof s.recentHigh).toBe("number");
    expect(typeof s.recentLow).toBe("number");
    expect(typeof s.pocPrice).toBe("number");
    expect(s.recentLow as number).toBeLessThan(s.recentHigh as number);
  });

  test("computeSeries returns priceLines (HH/LL + FVG bands)", () => {
    const series = structureLevelsPlugin.computeSeries(sampleCandles);
    expect(series.kind).toBe("priceLines");
    if (series.kind !== "priceLines") throw new Error();
    const titles = series.lines.map((l) => l.title);
    expect(titles).toContain("HH");
    expect(titles).toContain("LL");
  });

  test("detectorPromptFragment cites all 3 levels", () => {
    const txt = structureLevelsPlugin.detectorPromptFragment({
      recentHigh: 105.5, recentLow: 95.2, pocPrice: 100.1,
    });
    expect(txt).toContain("105.50");
    expect(txt).toContain("95.20");
    expect(txt).toContain("100.10");
  });

  test("computeScalars uses default params when no params", () => {
    const s = structureLevelsPlugin.computeScalars(sampleCandles);
    expect(typeof s.recentHigh).toBe("number");
    expect(typeof s.recentLow).toBe("number");
    expect(typeof s.pocPrice).toBe("number");
  });

  test("computeScalars accepts custom params", () => {
    // window=20 looks at fewer candles than default window=50
    const sDefault = structureLevelsPlugin.computeScalars(sampleCandles);
    const sCustom = structureLevelsPlugin.computeScalars(sampleCandles, { window: 20, poc_buckets: 15 });
    expect(typeof sCustom.recentHigh).toBe("number");
    // Smaller window should produce different (potentially tighter) high/low range
    expect(sDefault.recentHigh).not.toBe(sCustom.recentHigh);
  });

  test("paramsSchema validates ranges", () => {
    expect(() => structureLevelsPlugin.paramsSchema!.parse({ window: 9, poc_buckets: 30 })).toThrow(); // window below min
    expect(() => structureLevelsPlugin.paramsSchema!.parse({ window: 201, poc_buckets: 30 })).toThrow(); // window above max
    expect(() => structureLevelsPlugin.paramsSchema!.parse({ window: 50, poc_buckets: 9 })).toThrow(); // buckets below min
    expect(() => structureLevelsPlugin.paramsSchema!.parse({ window: 50, poc_buckets: 101 })).toThrow(); // buckets above max
    expect(structureLevelsPlugin.paramsSchema!.parse({ window: 50, poc_buckets: 30 })).toEqual({ window: 50, poc_buckets: 30 });
  });

  test("defaultParams matches schema", () => {
    expect(structureLevelsPlugin.paramsSchema!.parse(structureLevelsPlugin.defaultParams!)).toEqual(structureLevelsPlugin.defaultParams!);
  });
});

// ─── Ported from PureJsIndicatorCalculator.coverage.test.ts and .extended.test.ts ──

function baseCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(i * 900_000),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
}

describe("detectFvgs — deeper coverage [ported from FVG coverage tests]", () => {
  test("bearish FVG: candles[i-1].low > candles[i+1].high", () => {
    const candles = baseCandles(250);
    candles[100] = { ...candles[100]!, open: 112, high: 112, low: 110, close: 110, volume: 100 };
    candles[101] = { ...candles[101]!, open: 110, high: 110, low: 105, close: 105, volume: 100 };
    candles[102] = { ...candles[102]!, open: 105, high: 105, low: 103, close: 103, volume: 100 };

    const fvgs = detectFvgs(candles);
    const bearish = fvgs.find((f) => f.direction === "bearish" && f.index === 101);
    expect(bearish).toBeDefined();
    if (bearish) {
      // top = a.low (=110), bottom = c.high (=105)
      expect(bearish.top).toBeCloseTo(110, 5);
      expect(bearish.bottom).toBeCloseTo(105, 5);
    }
  });

  test("no FVG on flat adjacent bars", () => {
    const candles = baseCandles(250);
    const fvgs = detectFvgs(candles);
    expect(fvgs.length).toBe(0);
  });

  test("two distinct FVGs detected and ordered by index", () => {
    const candles = baseCandles(250);
    // Bullish gap at i=51: c[52].low > c[50].high
    candles[50] = { ...candles[50]!, high: 101, low: 99, close: 100 };
    candles[51] = { ...candles[51]!, open: 101, high: 102, low: 100.5, close: 101.5 };
    candles[52] = { ...candles[52]!, open: 102, high: 103, low: 102, close: 102.5 };
    candles[54] = { ...candles[54]!, open: 102, high: 102, low: 101, close: 101.5 };
    // Bearish gap at i=151: c[152].high < c[150].low
    candles[150] = { ...candles[150]!, open: 100, high: 101, low: 99, close: 99.5 };
    candles[151] = { ...candles[151]!, open: 99.5, high: 100, low: 99.5, close: 99.5 };
    candles[152] = { ...candles[152]!, open: 98, high: 98, low: 97, close: 97.5 };
    candles[154] = { ...candles[154]!, open: 98, high: 99, low: 98, close: 98.5 };

    const fvgs = detectFvgs(candles);
    expect(fvgs.length).toBe(2);
    const bullish = fvgs.find((f) => f.direction === "bullish" && f.index === 51);
    const bearish = fvgs.find((f) => f.direction === "bearish" && f.index === 151);
    expect(bullish).toBeDefined();
    expect(bearish).toBeDefined();
    const idxBull = fvgs.indexOf(bullish!);
    const idxBear = fvgs.indexOf(bearish!);
    expect(idxBull).toBeLessThan(idxBear);
  });

  test("touching but not gapping (a.high === c.low) → NOT detected as FVG", () => {
    const candles = baseCandles(250);
    candles[100] = { ...candles[100]!, high: 101, low: 99, close: 100 };
    candles[101] = { ...candles[101]!, high: 105, low: 101, close: 104 };
    candles[102] = { ...candles[102]!, high: 106, low: 101, close: 105 };
    const fvgs = detectFvgs(candles);
    const fvg = fvgs.find((f) => f.index === 101);
    expect(fvg).toBeUndefined();
  });

  test("FVG detection finds a 3-candle gap up (bullish)", () => {
    const candles = baseCandles(250);
    candles[100] = { ...candles[100]!, high: 100, low: 99, close: 99.5 };
    candles[101] = { ...candles[101]!, high: 110, low: 105, close: 109 };
    candles[102] = { ...candles[102]!, high: 112, low: 108, close: 110 };

    const fvgs = detectFvgs(candles);
    const bullishFvg = fvgs.find((f) => f.direction === "bullish" && f.index === 101);
    expect(bullishFvg).toBeDefined();
    if (bullishFvg) {
      // Gap between candles[100].high (=100) and candles[102].low (=108).
      expect(bullishFvg.bottom).toBeCloseTo(100, 1);
      expect(bullishFvg.top).toBeCloseTo(108, 1);
    }
  });
});
