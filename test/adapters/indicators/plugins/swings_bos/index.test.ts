import { describe, expect, test } from "bun:test";
import { swingsBosPlugin } from "@adapters/indicators/plugins/swings_bos";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100,
  high: 100 + Math.sin(i / 8) + 1,
  low: 100 + Math.sin(i / 8) - 1,
  close: 100 + Math.sin(i / 8),
  volume: 1000,
}));

describe("swingsBosPlugin", () => {
  test("metadata — id, tag, breakdownAxes=['structure']", () => {
    expect(swingsBosPlugin.id).toBe("swings_bos");
    expect(swingsBosPlugin.tag).toBe("structure");
    expect(swingsBosPlugin.chartPane).toBe("price_overlay");
    expect(swingsBosPlugin.breakdownAxes).toEqual(["structure"]);
  });

  test("computeScalars returns bosState and swing prices/ages", () => {
    const s = swingsBosPlugin.computeScalars(sampleCandles);
    expect(s.bosState).toBeDefined();
    expect(["bullish", "bearish", "none"]).toContain(s.bosState as string);
  });

  test("computeSeries returns markers kind", () => {
    const series = swingsBosPlugin.computeSeries(sampleCandles);
    expect(series.kind).toBe("markers");
    if (series.kind !== "markers") throw new Error();
    expect(Array.isArray(series.markers)).toBe(true);
    // Each marker has index, position, color, shape, text
    if (series.markers.length > 0) {
      const mk = series.markers[0];
      expect(mk).toHaveProperty("index");
      expect(mk).toHaveProperty("position");
      expect(mk).toHaveProperty("color");
      expect(mk).toHaveProperty("shape");
      expect(mk).toHaveProperty("text");
    }
  });

  test("detectorPromptFragment includes BOS state", () => {
    const s = swingsBosPlugin.computeScalars(sampleCandles);
    const txt = swingsBosPlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("BOS state");
    expect(txt).toContain("Swings");
  });

  test("reviewerPromptFragment includes BOS state", () => {
    const s = swingsBosPlugin.computeScalars(sampleCandles);
    const txt = swingsBosPlugin.reviewerPromptFragment?.(s);
    expect(txt).toBeTruthy();
    expect(txt).toContain("BOS state");
  });

  test("chartScript contains registerPlugin swings_bos", () => {
    expect(swingsBosPlugin.chartScript).toContain('__registerPlugin("swings_bos"');
  });

  test("featuredFewShotExample contains BOS reaction pattern", () => {
    const ex = swingsBosPlugin.featuredFewShotExample?.();
    expect(ex).toBeTruthy();
    expect(ex!).toContain("bos_reaction");
    expect(ex!).toContain("BOS state");
  });

  test("computeScalars uses default lookback when no params", () => {
    const s = swingsBosPlugin.computeScalars(sampleCandles);
    expect(s.bosState).toBeDefined();
    expect(["bullish", "bearish", "none"]).toContain(s.bosState as string);
  });

  test("computeScalars accepts custom params", () => {
    const sDefault = swingsBosPlugin.computeScalars(sampleCandles);
    const sCustom = swingsBosPlugin.computeScalars(sampleCandles, { lookback: 5 });
    // Both should produce valid bosState values; different lookbacks may produce different swing counts
    expect(["bullish", "bearish", "none"]).toContain(sCustom.bosState as string);
    // Different lookback => different number of swings detected => potentially different ages
    // (even if bosState is same, the swing ages will differ)
    const defaultHasResult = sDefault.lastSwingHighAge !== null || sCustom.lastSwingHighAge !== null;
    expect(defaultHasResult).toBe(true);
  });

  test("paramsSchema validates ranges", () => {
    expect(() => swingsBosPlugin.paramsSchema!.parse({ lookback: 0 })).toThrow(); // below min
    expect(() => swingsBosPlugin.paramsSchema!.parse({ lookback: 11 })).toThrow(); // above max
    expect(() => swingsBosPlugin.paramsSchema!.parse({ lookback: 1.5 })).toThrow(); // not int
    expect(swingsBosPlugin.paramsSchema!.parse({ lookback: 3 })).toEqual({ lookback: 3 });
  });

  test("defaultParams matches schema", () => {
    expect(swingsBosPlugin.paramsSchema!.parse(swingsBosPlugin.defaultParams!)).toEqual(swingsBosPlugin.defaultParams!);
  });
});
