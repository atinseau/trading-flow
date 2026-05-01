import { describe, expect, test } from "bun:test";
import { liquidityPoolsPlugin } from "@adapters/indicators/plugins/liquidity_pools";
import type { Candle } from "@domain/schemas/Candle";

// Generate candles with some repeated high/low levels to trigger equal pivots
const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100,
  high: 100 + Math.sin(i / 8) + 1,
  low: 100 + Math.sin(i / 8) - 1,
  close: 100 + Math.sin(i / 8),
  volume: 1000,
}));

describe("liquidityPoolsPlugin", () => {
  test("metadata — id, tag, breakdownAxes=['structure']", () => {
    expect(liquidityPoolsPlugin.id).toBe("liquidity_pools");
    expect(liquidityPoolsPlugin.tag).toBe("liquidity");
    expect(liquidityPoolsPlugin.chartPane).toBe("price_overlay");
    expect(liquidityPoolsPlugin.breakdownAxes).toEqual(["structure"]);
  });

  test("computeScalars returns topEqualHighs/Lows + counts", () => {
    const s = liquidityPoolsPlugin.computeScalars(sampleCandles);
    expect(s.equalHighsCount).toBeDefined();
    expect(s.equalLowsCount).toBeDefined();
    expect(s.topEqualHighs).toBeDefined();
    expect(s.topEqualLows).toBeDefined();
    expect(typeof s.equalHighsCount).toBe("number");
    expect(typeof s.equalLowsCount).toBe("number");
    expect(Array.isArray(s.topEqualHighs)).toBe(true);
    expect(Array.isArray(s.topEqualLows)).toBe(true);
    expect((s.topEqualHighs as unknown[]).length).toBeLessThanOrEqual(3);
    expect((s.topEqualLows as unknown[]).length).toBeLessThanOrEqual(3);
  });

  test("computeSeries returns priceLines kind", () => {
    const series = liquidityPoolsPlugin.computeSeries(sampleCandles);
    expect(series.kind).toBe("priceLines");
    if (series.kind !== "priceLines") throw new Error();
    expect(Array.isArray(series.lines)).toBe(true);
  });

  test("detectorPromptFragment includes liquidity pools section", () => {
    const s = liquidityPoolsPlugin.computeScalars(sampleCandles);
    const txt = liquidityPoolsPlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("Liquidity pools");
    expect(txt).toContain("Above");
    expect(txt).toContain("Below");
  });

  test("chartScript contains registerPlugin liquidity_pools", () => {
    expect(liquidityPoolsPlugin.chartScript).toContain('__registerPlugin("liquidity_pools"');
  });

  test("featuredFewShotExample contains sweep+reclaim pattern", () => {
    const ex = liquidityPoolsPlugin.featuredFewShotExample?.();
    expect(ex).toBeTruthy();
    expect(ex!).toContain("liquidity_sweep");
    expect(ex!).toContain("EQH");
  });
});

// ─── Ported from PureJsIndicatorCalculator.bosRegression.test.ts ─────────────
// The equalPivots tests were previously in the calculator-level file under
// "PureJsIndicatorCalculator — equalPivots (anchored cluster reference)".
// Ownership now belongs to the liquidity_pools plugin.

function flatCandleLp(i: number, price: number): Candle {
  return {
    timestamp: new Date(i * 900_000),
    open: price,
    high: price + 0.5,
    low: price - 0.5,
    close: price,
    volume: 100,
  };
}

function peakCandleLp(i: number, peakHigh: number, body = 100): Candle {
  return {
    timestamp: new Date(i * 900_000),
    open: body,
    high: peakHigh,
    low: body - 0.5,
    close: body,
    volume: 100,
  };
}

function seriesWithHighs(prices: number[], indices: number[], base = 100): Candle[] {
  const candles = Array.from({ length: 250 }, (_, i) => flatCandleLp(i, base));
  for (let k = 0; k < prices.length; k++) {
    const i = indices[k];
    const p = prices[k];
    if (i === undefined || p === undefined) continue;
    candles[i] = peakCandleLp(i, p);
  }
  return candles;
}

type EqualPivotCluster = { price: number; touches: number };
type LiquidityScalars = {
  topEqualHighs?: EqualPivotCluster[];
  topEqualLows?: EqualPivotCluster[];
  equalHighsCount?: number;
  equalLowsCount?: number;
};

describe("liquidityPoolsPlugin — equalPivots (anchored cluster reference) [ported]", () => {
  test("Order-independent clustering: same prices in different order produce same cluster count (regression)", () => {
    const seriesA = seriesWithHighs([110.0, 110.1, 110.2], [210, 225, 240]);
    const seriesB = seriesWithHighs([110.0, 110.2, 110.1], [210, 225, 240]);

    const indA = liquidityPoolsPlugin.computeScalars(seriesA) as LiquidityScalars;
    const indB = liquidityPoolsPlugin.computeScalars(seriesB) as LiquidityScalars;

    // Anchored implementation: both A and B produce the same cluster structure
    // (same split/grouping) regardless of insertion order.
    expect(indA.topEqualHighs?.length).toBe(indB.topEqualHighs?.length);
    expect(indA.equalHighsCount).toBe(indB.equalHighsCount);
    // Reported cluster prices must also match across orderings.
    const priceA = indA.topEqualHighs?.[0]?.price;
    const priceB = indB.topEqualHighs?.[0]?.price;
    expect(priceA).toBeDefined();
    expect(priceB).toBeDefined();
    if (priceA !== undefined && priceB !== undefined) {
      expect(priceA).toBeCloseTo(priceB, 4);
    }
  });

  test("Cluster reported price is the mean of its members", () => {
    // Three peaks at 110.00, 110.05, 110.10 — all within 0.1% of the 110.00
    // anchor — should form a single cluster of 3 with mean price ≈ 110.05.
    const candles = seriesWithHighs([110.0, 110.05, 110.1], [210, 225, 240]);
    const ind = liquidityPoolsPlugin.computeScalars(candles) as LiquidityScalars;
    expect(ind.topEqualHighs?.length).toBeGreaterThanOrEqual(1);
    const cluster = ind.topEqualHighs?.[0];
    expect(cluster).toBeDefined();
    if (!cluster) return;
    expect(cluster.touches).toBe(3);
    expect(cluster.price).toBeCloseTo(110.05, 2);
  });

  test("Tolerance boundary: pivots at 0.1% apart cluster, at 0.15% apart split", () => {
    // Within tolerance: 110.00 and 110.10 are ~0.091% apart → single cluster of 2.
    const within = seriesWithHighs([110.0, 110.1], [220, 240]);
    const indWithin = liquidityPoolsPlugin.computeScalars(within) as LiquidityScalars;
    expect(indWithin.topEqualHighs?.length).toBe(1);
    expect(indWithin.topEqualHighs?.[0]?.touches).toBe(2);

    // Outside tolerance: 110.00 and 110.165 are ~0.15% apart → no cluster.
    const outside = seriesWithHighs([110.0, 110.165], [220, 240]);
    const indOutside = liquidityPoolsPlugin.computeScalars(outside) as LiquidityScalars;
    expect(indOutside.topEqualHighs?.length).toBe(0);
  });

  test("Single pivot does not form a cluster (need ≥2 hits)", () => {
    const candles = seriesWithHighs([110.0], [230]);
    const ind = liquidityPoolsPlugin.computeScalars(candles) as LiquidityScalars;
    expect(ind.topEqualHighs?.length).toBe(0);
    expect(ind.equalHighsCount).toBe(0);
  });
});
