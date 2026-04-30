import { describe, expect, test } from "bun:test";
import { fvgPlugin } from "@adapters/indicators/plugins/fvg";

// Create candles with gaps to generate FVGs
const sampleCandles = Array.from({ length: 50 }, (_, i) => {
  const base = 100 + Math.sin(i / 5) * 5;
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1, i)),
    open: base,
    high: base + 2,
    low: base - 2,
    close: base + 1,
    volume: 1000,
  };
});

describe("fvgPlugin", () => {
  test("metadata — id, tag, breakdownAxes=['structure']", () => {
    expect(fvgPlugin.id).toBe("fvg");
    expect(fvgPlugin.tag).toBe("liquidity");
    expect(fvgPlugin.chartPane).toBe("price_overlay");
    expect(fvgPlugin.breakdownAxes).toEqual(["structure"]);
  });

  test("computeScalars returns empty object (no scalar)", () => {
    const s = fvgPlugin.computeScalars(sampleCandles);
    expect(Object.keys(s)).toHaveLength(0);
  });

  test("scalarSchemaFragment returns empty object", () => {
    const frag = fvgPlugin.scalarSchemaFragment();
    expect(Object.keys(frag)).toHaveLength(0);
  });

  test("computeSeries returns priceLines kind", () => {
    const series = fvgPlugin.computeSeries(sampleCandles);
    expect(series.kind).toBe("priceLines");
    if (series.kind !== "priceLines") throw new Error();
    expect(Array.isArray(series.lines)).toBe(true);
    // Each line pair covers top and bottom of a FVG
    for (const line of series.lines) {
      expect(line).toHaveProperty("price");
      expect(line).toHaveProperty("color");
      expect(line).toHaveProperty("style");
    }
  });

  test("detectorPromptFragment returns null (no scalar)", () => {
    const txt = fvgPlugin.detectorPromptFragment({});
    expect(txt).toBeNull();
  });

  test("chartScript contains registerPlugin fvg", () => {
    expect(fvgPlugin.chartScript).toContain('__registerPlugin("fvg"');
  });
});
