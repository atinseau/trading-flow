import { describe, expect, test } from "bun:test";
import { structureLevelsPlugin } from "@adapters/indicators/plugins/structure_levels";

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
});
