import { describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";

const calc = new PureJsIndicatorCalculator();
const registry = new IndicatorRegistry();
// Use all available plugins with defaults for percentile + pivot tests
const allPlugins = registry.resolveActive(
  Object.fromEntries(registry.all().map((p) => [p.id, { enabled: true }])),
);

type EqualPivotCluster = { price: number; touches: number };
type TestInd = Record<string, unknown> & {
  bbBandwidthPercentile200?: number;
  volumePercentile200?: number;
  topEqualHighs?: EqualPivotCluster[];
  topEqualLows?: EqualPivotCluster[];
};

/**
 * Deterministic synthetic-candle generator. Mirrors the helper in the
 * extended-tests file so each spec is reproducible without sharing state.
 */
function syntheticCandles(
  n: number,
  opts: {
    base?: number;
    vol?: number;
    drift?: number;
    noiseSeed?: number;
    noiseAmp?: number;
  } = {},
): Candle[] {
  const { base = 100, vol = 100, drift = 0, noiseSeed = 1, noiseAmp = 1 } = opts;
  let seed = noiseSeed;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const out: Candle[] = [];
  let close = base;
  for (let i = 0; i < n; i++) {
    const noise = (rand() - 0.5) * 2 * noiseAmp;
    close = Math.max(1, close + drift + noise);
    const high = close + Math.abs(noise) + 0.5;
    const low = close - Math.abs(noise) - 0.5;
    out.push({
      timestamp: new Date(i * 900_000),
      open: close - drift,
      high,
      low,
      close,
      volume: vol + Math.abs(noise) * 10,
    });
  }
  return out;
}

/** Build a perfectly flat candle (open=high=low=close). */
function flatCandle(i: number, price: number, volume: number): Candle {
  return {
    timestamp: new Date(i * 900_000),
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
  };
}

describe("PureJsIndicatorCalculator — bbBandwidthPercentile200", () => {
  test("low → high volatility transition produces a high percentile (>80)", async () => {
    // First 230 candles: tiny noise (low bandwidth). Last 20: very large noise
    // so the BB(20) bandwidth on the latest bar is dominated entirely by the
    // wild regime and dwarfs every value in the historical sample.
    const calm = syntheticCandles(230, { noiseSeed: 11, noiseAmp: 0.05 });
    const wild = syntheticCandles(20, {
      base: calm[calm.length - 1]?.close ?? 100,
      noiseSeed: 99,
      noiseAmp: 20,
    });
    const ind = await calc.compute([...calm, ...wild], allPlugins) as TestInd;
    expect(ind.bbBandwidthPercentile200).toBeGreaterThan(80);
  });

  test("high → low volatility transition (squeeze) produces a low percentile (<20)", async () => {
    // First 200 candles: wide noise. Last 50: very tight (squeeze).
    const wild = syntheticCandles(230, { noiseSeed: 11, noiseAmp: 20 });
    const calm = syntheticCandles(20, {
      base: wild[wild.length - 1]?.close ?? 100,
      noiseSeed: 99,
      noiseAmp: 0.02,
    });
    const ind = await calc.compute([...wild, ...calm], allPlugins) as TestInd;
    expect(ind.bbBandwidthPercentile200).toBeLessThan(20);
  });

  test("returns a valid 0..100 number with minimum (200) candles of warmup", async () => {
    // 200 candles is the absolute minimum compute() accepts. With BB(20)'s
    // 19-bar warmup, bandwidth200 has only 200 - 19 = 181 entries, so
    // slice(-201, -1) on a 181-element array yields 180 points (still enough
    // to produce a valid 0..100 percentile).
    const candles = syntheticCandles(200, { noiseSeed: 7 });
    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(typeof ind.bbBandwidthPercentile200).toBe("number");
    expect(ind.bbBandwidthPercentile200).toBeGreaterThanOrEqual(0);
    expect(ind.bbBandwidthPercentile200).toBeLessThanOrEqual(100);
  });
});

describe("PureJsIndicatorCalculator — volumePercentile200", () => {
  test("volume spike on the latest candle yields a high percentile", async () => {
    const candles = syntheticCandles(250, { vol: 100, noiseSeed: 3 });
    const last = candles[candles.length - 1];
    if (!last) throw new Error("expected candle");
    candles[candles.length - 1] = { ...last, volume: 100_000 };
    const ind = await calc.compute(candles, allPlugins) as TestInd;
    // Spike is far above every sample; percentileOf returns ~100.
    expect(ind.volumePercentile200).toBeGreaterThan(95);
  });

  test("anemic volume on the latest candle yields a low percentile", async () => {
    const candles = syntheticCandles(250, { vol: 1_000, noiseSeed: 3 });
    const last = candles[candles.length - 1];
    if (!last) throw new Error("expected candle");
    candles[candles.length - 1] = { ...last, volume: 1 };
    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.volumePercentile200).toBeLessThan(5);
  });

  test("constant volume across the series → percentile ~50 (all equal)", async () => {
    // When every value in the sample equals `value`, percentileOf reports
    // exactly equal/2 = 50 (half-below tie-handling).
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 100, 500));
    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.volumePercentile200).toBeCloseTo(50, 5);
  });
});

describe("PureJsIndicatorCalculator — topEqualHighs / topEqualLows", () => {
  test("3 distinct clean clusters → 3 entries returned, sorted by touches desc", async () => {
    // Three clusters at different price levels. Cluster A (210, 220, 230, 240) → 4 touches.
    // Cluster B (215, 225, 235) → 3 touches. Cluster C (212, 232) → 2 touches.
    // Tolerance = 0.1% so each cluster must stay within ~0.1 of its anchor.
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 100, 100));
    const setPeak = (i: number, peak: number) => {
      candles[i] = {
        timestamp: new Date(i * 900_000),
        open: 100,
        high: peak,
        low: 100,
        close: 100,
        volume: 100,
      };
    };
    // Cluster A near 130 (4 touches).
    for (const i of [210, 220, 230, 240]) setPeak(i, 130);
    // Cluster B near 120 (3 touches).
    for (const i of [213, 223, 233]) setPeak(i, 120);
    // Cluster C near 140 (2 touches).
    for (const i of [216, 236]) setPeak(i, 140);

    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.topEqualHighs.length).toBe(3);
    // Descending by touches.
    expect(ind.topEqualHighs[0]?.touches).toBe(4);
    expect(ind.topEqualHighs[1]?.touches).toBe(3);
    expect(ind.topEqualHighs[2]?.touches).toBe(2);
  });

  test("more than 3 clusters → only top 3 (by touches) returned", async () => {
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 100, 100));
    const setPeak = (i: number, peak: number) => {
      candles[i] = {
        timestamp: new Date(i * 900_000),
        open: 100,
        high: peak,
        low: 100,
        close: 100,
        volume: 100,
      };
    };
    // 4 distinct clusters with descending touch counts (5, 4, 3, 2). Peak
    // indices are spaced ≥ 3 apart so each one is a strict 3-bar fractal
    // (i±2 sits on flat 100 background). All indices stay within [200, 246]
    // (RECENT_WINDOW = 50 so we need i ≥ 200; right-edge needs i ≤ n-3 = 247
    // for the fractal lookforward).
    for (const i of [201, 204, 207, 210, 213]) setPeak(i, 130); // 5
    for (const i of [217, 220, 223, 226]) setPeak(i, 140); // 4
    for (const i of [230, 233, 236]) setPeak(i, 150); // 3
    for (const i of [240, 243]) setPeak(i, 160); // 2

    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.topEqualHighs.length).toBe(3);
    // Cluster with 2 touches should be dropped; remaining are 5, 4, 3.
    expect(ind.topEqualHighs.map((c) => c.touches)).toEqual([5, 4, 3]);
  });

  test("no clusters (no equal pivots) → empty array", async () => {
    // Pure synthetic noise rarely yields equal pivots within 0.1% — but to be
    // unconditional, use a strictly monotonic series so every swing pivot has
    // a unique price.
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 100,
    }));
    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.topEqualHighs).toEqual([]);
    expect(ind.topEqualLows).toEqual([]);
  });

  test("cluster price is the MEAN of member pivot prices, not the first pivot", async () => {
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 100, 100));
    // Two peaks anchored ~130 with a small spread inside tolerance: 130 and 130.1.
    // mean = 130.05 ; first-pivot anchor would be 130 exactly.
    candles[210] = {
      timestamp: new Date(210 * 900_000),
      open: 100,
      high: 130,
      low: 100,
      close: 100,
      volume: 100,
    };
    candles[230] = {
      timestamp: new Date(230 * 900_000),
      open: 100,
      high: 130.1,
      low: 100,
      close: 100,
      volume: 100,
    };
    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.topEqualHighs.length).toBe(1);
    const cluster = ind.topEqualHighs[0];
    if (!cluster) throw new Error("expected cluster");
    expect(cluster.touches).toBe(2);
    expect(cluster.price).toBeCloseTo((130 + 130.1) / 2, 5);
  });

  test("topEqualLows: 3 distinct trough clusters → 3 entries, prices = mean of cluster members", async () => {
    // Symmetric to the topEqualHighs positive test, but on swing LOWS. Build
    // a flat-100 background and carve troughs (low < 100) at indices spaced
    // ≥ 3 apart so each is a strict 3-bar fractal. All trough indices stay in
    // [200, 246] to satisfy RECENT_WINDOW = 50 and the fractal lookforward.
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 100, 100));
    const setTrough = (i: number, trough: number) => {
      candles[i] = {
        timestamp: new Date(i * 900_000),
        open: 100,
        high: 100,
        low: trough,
        close: trough,
        volume: 100,
      };
    };
    // Cluster A near 70 (4 troughs).
    const aIdx = [201, 204, 207, 210];
    const aPrices = [70, 70.05, 69.95, 70.02];
    aIdx.forEach((i, k) => setTrough(i, aPrices[k] as number));
    // Cluster B near 80 (3 troughs).
    const bIdx = [214, 217, 220];
    const bPrices = [80, 80.04, 79.97];
    bIdx.forEach((i, k) => setTrough(i, bPrices[k] as number));
    // Cluster C near 60 (2 troughs).
    const cIdx = [225, 228];
    const cPrices = [60, 60.05];
    cIdx.forEach((i, k) => setTrough(i, cPrices[k] as number));

    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.topEqualLows.length).toBe(3);
    // Descending touches.
    expect(ind.topEqualLows.map((c) => c.touches)).toEqual([4, 3, 2]);
    // Cluster prices = mean of member prices.
    const meanA = aPrices.reduce((s, p) => s + p, 0) / aPrices.length;
    const meanB = bPrices.reduce((s, p) => s + p, 0) / bPrices.length;
    const meanC = cPrices.reduce((s, p) => s + p, 0) / cPrices.length;
    expect(ind.topEqualLows[0]?.price).toBeCloseTo(meanA, 5);
    expect(ind.topEqualLows[1]?.price).toBeCloseTo(meanB, 5);
    expect(ind.topEqualLows[2]?.price).toBeCloseTo(meanC, 5);
  });

  test("equalPivots tolerance boundary: spread > EQUAL_PIVOT_TOLERANCE_PCT (0.1%) → no cluster", async () => {
    // Two swing highs whose price spread sits JUST OUTSIDE the 0.1% tolerance.
    // Anchor = 100 → membership requires |p - 100| / 100 <= 0.001, i.e.
    // p ≤ 100.1. A second pivot at 100.11 has relative distance 0.0011 (just
    // above the 0.001 threshold), so the two pivots must NOT cluster and
    // topEqualHighs is empty (no group has ≥ 2 hits). Without this guard the
    // tolerance constant could be raised 100× and existing tests would still
    // pass.
    // Background high = 99 so peaks at ~100 are unambiguous fractal swings.
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 99, 100));
    const setPeak = (i: number, peak: number) => {
      candles[i] = {
        timestamp: new Date(i * 900_000),
        open: 99,
        high: peak,
        low: 99,
        close: 99,
        volume: 100,
      };
    };
    setPeak(210, 100);
    setPeak(230, 100.11); // ~0.11% above anchor — just outside the 0.1% tolerance.

    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.topEqualHighs).toEqual([]);
  });
});

describe("PureJsIndicatorCalculator — lastSwingHigh / lastSwingLow age", () => {
  test("last swing high age = (n-1) - lastSwingHighIdx for known fractal placement", async () => {
    // Build a 250-candle series with three crisp single-bar peaks at indices
    // 50, 100, 150. Between/around them, prices are flat at 100. Each peak is
    // a strict 3-bar fractal (SWING_LOOKBACK = 2 → bar i is a swing if
    // highs[i] > highs[i±1] and highs[i±2]). Avoid placing peaks within 2 of
    // the last index (boundary 2 = swing fractal lookback so the last swing
    // index lags by 2 anyway).
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 100, 100));
    for (const i of [50, 100, 150]) {
      candles[i] = {
        timestamp: new Date(i * 900_000),
        open: 100,
        high: 110,
        low: 100,
        close: 110,
        volume: 100,
      };
    }
    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.lastSwingHigh).toBe(110);
    // n-1 = 249; lastSwingHighIdx = 150 → age = 99.
    expect(ind.lastSwingHighAge).toBe(99);
  });

  test("last swing low age = (n-1) - lastSwingLowIdx for known fractal placement", async () => {
    // Symmetric to the lastSwingHigh test: build three crisp single-bar
    // troughs at indices 50, 100, 150. Background lows are flat at 100; each
    // trough has low = 90. SWING_LOOKBACK = 2 so each trough is a strict
    // 3-bar fractal (lows[i] < lows[i±1] and lows[i±2]).
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 100, 100));
    for (const i of [50, 100, 150]) {
      candles[i] = {
        timestamp: new Date(i * 900_000),
        open: 100,
        high: 100,
        low: 90,
        close: 90,
        volume: 100,
      };
    }
    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.lastSwingLow).toBe(90);
    // n-1 = 249; lastSwingLowIdx = 150 → age = 99.
    expect(ind.lastSwingLowAge).toBe(99);
  });

  test("uniform series (no fractal swings) → lastSwingHigh / age are null", async () => {
    // Perfectly flat: no bar is strictly greater than both neighbours, so no
    // swing is ever detected.
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 100, 100));
    const ind = await calc.compute(candles, allPlugins) as TestInd;
    expect(ind.lastSwingHigh).toBeNull();
    expect(ind.lastSwingHighAge).toBeNull();
    expect(ind.lastSwingLow).toBeNull();
    expect(ind.lastSwingLowAge).toBeNull();
  });

  test("age increments by 1 when an extra flat candle is appended (no new swing)", async () => {
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 100, 100));
    // Single peak at 150; no other candle high > 100.
    candles[150] = {
      timestamp: new Date(150 * 900_000),
      open: 100,
      high: 110,
      low: 100,
      close: 110,
      volume: 100,
    };
    const indA = await calc.compute(candles);
    // Append one more flat candle: no new swing prints, but age grows by 1.
    const candlesPlusOne = [...candles, flatCandle(250, 100, 100)];
    const indB = await calc.compute(candlesPlusOne);
    if (indA.lastSwingHighAge == null || indB.lastSwingHighAge == null) {
      throw new Error("expected non-null swing ages");
    }
    expect(indB.lastSwingHighAge).toBe(indA.lastSwingHighAge + 1);
  });
});
