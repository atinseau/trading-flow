import { describe, expect, test } from "bun:test";
import { bollingerPlugin } from "@adapters/indicators/plugins/bollinger";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 10), volume: 1000,
}));

describe("bollingerPlugin", () => {
  test("metadata", () => {
    expect(bollingerPlugin.id).toBe("bollinger");
    expect(bollingerPlugin.tag).toBe("volatility");
    expect(bollingerPlugin.chartPane).toBe("price_overlay");
  });

  test("computeScalars includes bbUpper, bbMiddle, bbLower, bbBandwidthPct, bbBandwidthPercentile200", () => {
    const s = bollingerPlugin.computeScalars(sampleCandles);
    expect(s.bbUpper).toBeDefined();
    expect(s.bbMiddle).toBeDefined();
    expect(s.bbLower).toBeDefined();
    expect(s.bbBandwidthPct).toBeDefined();
    expect(s.bbBandwidthPercentile200).toBeDefined();
  });

  test("bbUpper > bbMiddle > bbLower", () => {
    const s = bollingerPlugin.computeScalars(sampleCandles);
    expect(s.bbUpper as number).toBeGreaterThan(s.bbMiddle as number);
    expect(s.bbMiddle as number).toBeGreaterThan(s.bbLower as number);
  });

  test("computeSeries returns upper/middle/lower line series", () => {
    const series = bollingerPlugin.computeSeries(sampleCandles);
    if (series.kind !== "lines") throw new Error("expected lines kind");
    expect(series.series.upper).toBeDefined();
    expect(series.series.middle).toBeDefined();
    expect(series.series.lower).toBeDefined();
    expect(series.series.upper.length).toBe(250);
  });

  test("detectorPromptFragment mentions bandwidth", () => {
    const s = bollingerPlugin.computeScalars(sampleCandles);
    const txt = bollingerPlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toMatch(/BB\(?\d+/);
    expect(txt).toContain("bandwidth");
  });

  test("detectorPromptFragment inlines custom period and std_mul", () => {
    const s = bollingerPlugin.computeScalars(sampleCandles, { period: 10, std_mul: 1.5 });
    const txt = bollingerPlugin.detectorPromptFragment(s, { period: 10, std_mul: 1.5 });
    expect(txt).toContain("BB(10, 1.5σ)");
  });

  test("reviewerPromptFragment is condensed", () => {
    const s = bollingerPlugin.computeScalars(sampleCandles);
    const txt = bollingerPlugin.reviewerPromptFragment?.(s);
    expect(txt).toBeTruthy();
    expect(txt!.length).toBeLessThan(80);
  });

  test("chartScript contains registerPlugin bollinger", () => {
    expect(bollingerPlugin.chartScript).toContain('__registerPlugin("bollinger"');
  });

  test("featuredFewShotExample contains BB squeeze breakout pattern", () => {
    const ex = bollingerPlugin.featuredFewShotExample?.();
    expect(ex).toBeTruthy();
    expect(ex!).toContain("bb_squeeze_breakout");
    expect(ex!).toContain("BB bandwidth");
    expect(ex!).toContain("confidence_breakdown");
  });

  test("computeScalars uses default params when no params", () => {
    const s = bollingerPlugin.computeScalars(sampleCandles);
    expect(s.bbUpper).toBeDefined();
    expect(s.bbMiddle).toBeDefined();
    expect(s.bbLower).toBeDefined();
  });

  test("computeScalars accepts custom params", () => {
    const sDefault = bollingerPlugin.computeScalars(sampleCandles);
    const sCustom = bollingerPlugin.computeScalars(sampleCandles, { period: 10, std_mul: 1.5 });
    expect(typeof sCustom.bbUpper).toBe("number");
    // Different period/std_mul should produce different band values
    expect(sDefault.bbUpper).not.toBe(sCustom.bbUpper);
  });

  test("paramsSchema validates ranges", () => {
    expect(() => bollingerPlugin.paramsSchema!.parse({ period: 4, std_mul: 2 })).toThrow(); // period below min
    expect(() => bollingerPlugin.paramsSchema!.parse({ period: 101, std_mul: 2 })).toThrow(); // period above max
    expect(() => bollingerPlugin.paramsSchema!.parse({ period: 20, std_mul: 0.4 })).toThrow(); // std_mul below min
    expect(() => bollingerPlugin.paramsSchema!.parse({ period: 20, std_mul: 5 })).toThrow(); // std_mul above max
    expect(bollingerPlugin.paramsSchema!.parse({ period: 20, std_mul: 2 })).toEqual({ period: 20, std_mul: 2 });
  });

  test("defaultParams matches schema", () => {
    expect(bollingerPlugin.paramsSchema!.parse(bollingerPlugin.defaultParams!)).toEqual(bollingerPlugin.defaultParams!);
  });
});
