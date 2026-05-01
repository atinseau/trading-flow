import { describe, expect, test } from "bun:test";
import { emaStackPlugin } from "@adapters/indicators/plugins/ema_stack";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 10), volume: 1000,
}));

describe("emaStackPlugin", () => {
  test("metadata", () => {
    expect(emaStackPlugin.id).toBe("ema_stack");
    expect(emaStackPlugin.tag).toBe("trend");
    expect(emaStackPlugin.chartPane).toBe("price_overlay");
  });

  test("computeScalars returns ema20/50/200", () => {
    const s = emaStackPlugin.computeScalars(sampleCandles);
    expect(s.ema20).toBeDefined();
    expect(s.ema50).toBeDefined();
    expect(s.ema200).toBeDefined();
    expect(typeof s.ema20).toBe("number");
    expect(typeof s.ema50).toBe("number");
    expect(typeof s.ema200).toBe("number");
  });

  test("computeSeries returns 3 line series", () => {
    const series = emaStackPlugin.computeSeries(sampleCandles);
    if (series.kind !== "lines") throw new Error("expected lines kind");
    expect(Object.keys(series.series).sort()).toEqual(["ema20", "ema200", "ema50"]);
  });

  test("computeSeries series have length equal to candle count", () => {
    const series = emaStackPlugin.computeSeries(sampleCandles);
    if (series.kind !== "lines") throw new Error();
    expect(series.series.ema20.length).toBe(250);
    expect(series.series.ema50.length).toBe(250);
    expect(series.series.ema200.length).toBe(250);
  });

  test("detectorPromptFragment includes EMA stack label and values", () => {
    const s = emaStackPlugin.computeScalars(sampleCandles);
    const txt = emaStackPlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("EMA stack");
    expect(txt).toContain("alignment = trend regime");
  });

  test("chartScript contains registerPlugin ema_stack", () => {
    expect(emaStackPlugin.chartScript).toContain('__registerPlugin("ema_stack"');
  });

  test("computeScalars uses default periods when no params", () => {
    const s = emaStackPlugin.computeScalars(sampleCandles);
    expect(s.ema20).toBeDefined();
    expect(s.ema50).toBeDefined();
    expect(s.ema200).toBeDefined();
  });

  test("computeScalars accepts custom params", () => {
    const sDefault = emaStackPlugin.computeScalars(sampleCandles);
    const sCustom = emaStackPlugin.computeScalars(sampleCandles, {
      period_short: 10, period_mid: 30, period_long: 100,
    });
    expect(typeof sCustom.ema20).toBe("number");
    // Different periods should produce different EMA values
    expect(sDefault.ema20).not.toBe(sCustom.ema20);
  });

  test("paramsSchema validates ranges", () => {
    expect(() => emaStackPlugin.paramsSchema!.parse({
      period_short: 1, period_mid: 50, period_long: 200,
    })).toThrow(); // period_short below min
    expect(() => emaStackPlugin.paramsSchema!.parse({
      period_short: 20, period_mid: 10, period_long: 200,
    })).toThrow(); // short >= mid
    expect(() => emaStackPlugin.paramsSchema!.parse({
      period_short: 20, period_mid: 50, period_long: 40,
    })).toThrow(); // mid >= long
    expect(emaStackPlugin.paramsSchema!.parse({
      period_short: 20, period_mid: 50, period_long: 200,
    })).toEqual({ period_short: 20, period_mid: 50, period_long: 200 });
  });

  test("defaultParams matches schema", () => {
    expect(emaStackPlugin.paramsSchema!.parse(emaStackPlugin.defaultParams!)).toEqual(emaStackPlugin.defaultParams!);
  });
});
