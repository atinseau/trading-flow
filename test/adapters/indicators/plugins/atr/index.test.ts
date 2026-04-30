import { describe, expect, test } from "bun:test";
import { atrPlugin } from "@adapters/indicators/plugins/atr";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 10), volume: 1000,
}));

describe("atrPlugin", () => {
  test("metadata — id, tag, preFilterCriterion=atr_ratio_min", () => {
    expect(atrPlugin.id).toBe("atr");
    expect(atrPlugin.tag).toBe("volatility");
    expect(atrPlugin.chartPane).toBe("secondary");
    expect(atrPlugin.preFilterCriterion).toBe("atr_ratio_min");
  });

  test("computeScalars returns atr, atrMa20, atrZScore200", () => {
    const s = atrPlugin.computeScalars(sampleCandles);
    expect(s.atr).toBeDefined();
    expect(s.atrMa20).toBeDefined();
    expect(s.atrZScore200).toBeDefined();
    expect(typeof s.atr).toBe("number");
    expect(typeof s.atrMa20).toBe("number");
    expect(typeof s.atrZScore200).toBe("number");
    expect(s.atr as number).toBeGreaterThanOrEqual(0);
  });

  test("computeSeries returns atr/atrMa20 lines of length n", () => {
    const series = atrPlugin.computeSeries(sampleCandles);
    if (series.kind !== "lines") throw new Error("expected lines kind");
    expect(series.series.atr).toBeDefined();
    expect(series.series.atrMa20).toBeDefined();
    expect(series.series.atr.length).toBe(250);
    expect(series.series.atrMa20.length).toBe(250);
  });

  test("detectorPromptFragment includes ATR and z-score", () => {
    const s = atrPlugin.computeScalars(sampleCandles);
    const txt = atrPlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("ATR");
    expect(txt).toContain("z-score");
  });

  test("reviewerPromptFragment is condensed", () => {
    const s = atrPlugin.computeScalars(sampleCandles);
    const txt = atrPlugin.reviewerPromptFragment?.(s);
    expect(txt).toBeTruthy();
    expect(txt!.length).toBeLessThan(60);
  });

  test("chartScript contains registerPlugin atr", () => {
    expect(atrPlugin.chartScript).toContain('__registerPlugin("atr"');
  });
});
