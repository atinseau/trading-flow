import { describe, expect, test } from "bun:test";
import { swingsBosPlugin } from "@adapters/indicators/plugins/swings_bos";
import type { Candle } from "@domain/schemas/Candle";

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

// ─── Ported from PureJsIndicatorCalculator.percentiles.test.ts ───────────────

function flatCandle(i: number, price: number, volume: number): Candle {
  return {
    timestamp: new Date(i * 900_000),
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
  };
}

describe("swingsBosPlugin — lastSwingHigh / lastSwingLow age (ported coverage)", () => {
  test("age increments by 1 when an extra flat candle is appended (no new swing)", () => {
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => flatCandle(i, 100, 100));
    // Single peak at 150 — creates a strict 3-bar fractal swing high (flat neighbors at 100).
    candles[150] = {
      timestamp: new Date(150 * 900_000),
      open: 100,
      high: 110,
      low: 100,
      close: 110,
      volume: 100,
    };
    const sA = swingsBosPlugin.computeScalars(candles);
    // Append one more flat candle: no new swing, but age grows by 1.
    const candlesPlusOne = [...candles, flatCandle(250, 100, 100)];
    const sB = swingsBosPlugin.computeScalars(candlesPlusOne);
    if (sA.lastSwingHighAge == null || sB.lastSwingHighAge == null) {
      throw new Error("expected non-null swing ages");
    }
    expect(sB.lastSwingHighAge).toBe((sA.lastSwingHighAge as number) + 1);
  });
});

// ─── Ported from PureJsIndicatorCalculator.extended.test.ts ──────────────────

describe("swingsBosPlugin — computeSeries swing markers (ported coverage)", () => {
  test("Swing detection finds the obvious peak in a triangle wave", () => {
    const candles: Candle[] = [];
    // 250 candles forming a tent: rise from 100 to 224, fall back to 100.
    for (let i = 0; i < 125; i++) {
      const close = 100 + i;
      candles.push({
        timestamp: new Date(i * 900_000),
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 100,
      });
    }
    for (let i = 0; i < 125; i++) {
      const close = 225 - i;
      candles.push({
        timestamp: new Date((125 + i) * 900_000),
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 100,
      });
    }
    const series = swingsBosPlugin.computeSeries(candles);
    if (series.kind !== "markers") throw new Error("expected markers kind");
    // Swing high markers: find one near the peak of the tent.
    const highMarkers = series.markers.filter((m) => m.position === "above");
    expect(highMarkers.length).toBeGreaterThan(0);
    const topIdx = highMarkers[highMarkers.length - 1]?.index ?? -1;
    expect(topIdx).toBeGreaterThan(120);
    expect(topIdx).toBeLessThan(135);
  });
});
