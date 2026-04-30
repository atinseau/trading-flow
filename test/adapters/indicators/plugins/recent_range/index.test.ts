import { describe, expect, test } from "bun:test";
import { recentRangePlugin } from "@adapters/indicators/plugins/recent_range";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100,
  high: 100 + Math.sin(i / 8) + 1,
  low: 100 + Math.sin(i / 8) - 1,
  close: 100 + Math.sin(i / 8),
  volume: 1000,
}));

describe("recentRangePlugin", () => {
  test("metadata — id, tag, preFilterCriterion='near_pivot', breakdownAxes=['structure']", () => {
    expect(recentRangePlugin.id).toBe("recent_range");
    expect(recentRangePlugin.tag).toBe("structure");
    expect(recentRangePlugin.chartPane).toBe("price_overlay");
    expect(recentRangePlugin.preFilterCriterion).toBe("near_pivot");
    expect(recentRangePlugin.breakdownAxes).toEqual(["structure"]);
  });

  test("computeScalars returns recentHigh and recentLow", () => {
    const s = recentRangePlugin.computeScalars(sampleCandles);
    expect(s.recentHigh).toBeDefined();
    expect(s.recentLow).toBeDefined();
    expect(typeof s.recentHigh).toBe("number");
    expect(typeof s.recentLow).toBe("number");
    expect(s.recentHigh as number).toBeGreaterThan(s.recentLow as number);
  });

  test("computeSeries returns priceLines kind with 2 lines", () => {
    const series = recentRangePlugin.computeSeries(sampleCandles);
    expect(series.kind).toBe("priceLines");
    if (series.kind !== "priceLines") throw new Error();
    expect(series.lines.length).toBe(2);
    const titles = series.lines.map((l) => l.title);
    expect(titles).toContain("HH");
    expect(titles).toContain("LL");
  });

  test("detectorPromptFragment includes recent range info", () => {
    const s = recentRangePlugin.computeScalars(sampleCandles);
    const txt = recentRangePlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("Recent range");
    expect(txt).toContain("high=");
    expect(txt).toContain("low=");
  });

  test("chartScript contains registerPlugin recent_range", () => {
    expect(recentRangePlugin.chartScript).toContain('__registerPlugin("recent_range"');
  });
});
