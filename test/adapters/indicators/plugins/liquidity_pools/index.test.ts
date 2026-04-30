import { describe, expect, test } from "bun:test";
import { liquidityPoolsPlugin } from "@adapters/indicators/plugins/liquidity_pools";

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
});
