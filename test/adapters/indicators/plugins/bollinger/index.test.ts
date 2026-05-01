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
    expect(txt).toContain("BB bandwidth");
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
});
