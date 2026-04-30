import { describe, expect, test } from "bun:test";
import { pocPlugin } from "@adapters/indicators/plugins/poc";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100,
  high: 100 + Math.sin(i / 10) + 1,
  low: 100 + Math.sin(i / 10) - 1,
  close: 100 + Math.sin(i / 10),
  volume: 1000 + (i % 20) * 100,
}));

describe("pocPlugin", () => {
  test("metadata — id, tag, breakdownAxes=['structure']", () => {
    expect(pocPlugin.id).toBe("poc");
    expect(pocPlugin.tag).toBe("liquidity");
    expect(pocPlugin.chartPane).toBe("price_overlay");
    expect(pocPlugin.breakdownAxes).toEqual(["structure"]);
  });

  test("computeScalars returns pocPrice scalar", () => {
    const s = pocPlugin.computeScalars(sampleCandles);
    expect(s.pocPrice).toBeDefined();
    expect(typeof s.pocPrice).toBe("number");
    expect(s.pocPrice as number).toBeGreaterThan(0);
  });

  test("computeSeries returns lines kind with empty series", () => {
    const series = pocPlugin.computeSeries(sampleCandles);
    expect(series.kind).toBe("lines");
    if (series.kind !== "lines") throw new Error();
    expect(Object.keys(series.series)).toHaveLength(0);
  });

  test("detectorPromptFragment includes POC price", () => {
    const s = pocPlugin.computeScalars(sampleCandles);
    const txt = pocPlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("POC");
    expect(txt).toContain("mean-reversion");
  });

  test("reviewerPromptFragment is condensed and includes POC", () => {
    const s = pocPlugin.computeScalars(sampleCandles);
    const txt = pocPlugin.reviewerPromptFragment?.(s);
    expect(txt).toBeTruthy();
    expect(txt).toContain("POC");
    expect(txt!.length).toBeLessThan(30);
  });

  test("chartScript contains registerPlugin poc (no-op)", () => {
    expect(pocPlugin.chartScript).toContain('__registerPlugin("poc"');
  });
});
