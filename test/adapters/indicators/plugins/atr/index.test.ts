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

  test("computeScalars uses default period when no params", () => {
    const s = atrPlugin.computeScalars(sampleCandles);
    expect(s.atr).toBeDefined();
    expect(s.atrMa20).toBeDefined();
    expect(s.atrZScore200).toBeDefined();
  });

  test("computeScalars accepts custom params", () => {
    // Use candles with varying volatility so different periods produce different z-scores
    const volatileCandles = Array.from({ length: 250 }, (_, i) => {
      const vol = i < 125 ? 1 : 3;
      return {
        timestamp: new Date(Date.UTC(2026, 0, 1, i)),
        open: 100, high: 100 + vol, low: 100 - vol, close: 100, volume: 1000,
      };
    });
    const sDefault = atrPlugin.computeScalars(volatileCandles);
    const sCustom = atrPlugin.computeScalars(volatileCandles, { period: 7 });
    expect(typeof sCustom.atr).toBe("number");
    // Different periods should produce different z-scores on asymmetric volatility data
    expect(sDefault.atrZScore200).not.toBe(sCustom.atrZScore200);
  });

  test("paramsSchema validates ranges", () => {
    expect(() => atrPlugin.paramsSchema!.parse({ period: 1 })).toThrow(); // below min
    expect(() => atrPlugin.paramsSchema!.parse({ period: 51 })).toThrow(); // above max
    expect(() => atrPlugin.paramsSchema!.parse({ period: 14.5 })).toThrow(); // not int
    expect(atrPlugin.paramsSchema!.parse({ period: 14 })).toEqual({ period: 14 });
  });

  test("defaultParams matches schema", () => {
    expect(atrPlugin.paramsSchema!.parse(atrPlugin.defaultParams!)).toEqual(atrPlugin.defaultParams!);
  });
});
