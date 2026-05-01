import { describe, expect, test } from "bun:test";
import { vwapPlugin } from "@adapters/indicators/plugins/vwap";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 10), volume: 1000,
}));

describe("vwapPlugin", () => {
  test("metadata", () => {
    expect(vwapPlugin.id).toBe("vwap");
    expect(vwapPlugin.tag).toBe("trend");
    expect(vwapPlugin.chartPane).toBe("price_overlay");
  });

  test("computeScalars includes vwapSession + priceVsVwapPct", () => {
    const s = vwapPlugin.computeScalars(sampleCandles);
    expect(s.vwapSession).toBeDefined();
    expect(s.priceVsVwapPct).toBeDefined();
    expect(typeof s.vwapSession).toBe("number");
    expect(typeof s.priceVsVwapPct).toBe("number");
  });

  test("computeSeries returns vwap line series", () => {
    const series = vwapPlugin.computeSeries(sampleCandles);
    if (series.kind !== "lines") throw new Error("expected lines kind");
    expect(series.series.vwap).toBeDefined();
    expect(series.series.vwap.length).toBe(250);
  });

  test("detectorPromptFragment includes VWAP label and pct", () => {
    const s = vwapPlugin.computeScalars(sampleCandles);
    const txt = vwapPlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("VWAP session");
    expect(txt).toContain("price vs VWAP");
  });

  test("chartScript contains registerPlugin vwap", () => {
    expect(vwapPlugin.chartScript).toContain('__registerPlugin("vwap"');
  });
});

// ─── Ported from PureJsIndicatorCalculator.coverage.test.ts ──────────────────

describe("vwapPlugin — session edge cases [ported]", () => {
  test("VWAP resets at UTC midnight (just-after-midnight VWAP = first candle's typical price)", () => {
    const ms = 86_400_000;
    const stepMs = 3_600_000;
    const lastTs = 5 * ms;
    const startMs = lastTs - 249 * stepMs;
    const candles = [];
    for (let i = 0; i < 250; i++) {
      const ts = startMs + i * stepMs;
      const onNewDay = Math.floor(ts / ms) === 5;
      const price = onNewDay ? 200 : 100;
      candles.push({
        timestamp: new Date(ts),
        open: price,
        high: price + 1,
        low: price - 1,
        close: price,
        volume: 100,
      });
    }
    // Confirm partition: last candle is day 5, prev candle is day 4.
    expect(Math.floor(candles[candles.length - 1]!.timestamp.getTime() / ms)).toBe(5);
    expect(Math.floor(candles[candles.length - 2]!.timestamp.getTime() / ms)).toBe(4);

    const raw = vwapPlugin.computeSeries(candles);
    if (raw.kind !== "lines") throw new Error("expected lines kind");
    const vwapArr = raw.series.vwap;
    const lastVwap = vwapArr[vwapArr.length - 1];
    const prevVwap = vwapArr[vwapArr.length - 2];
    // Just-after-midnight: the fresh-day candle's typical price is 200.
    // computeSeries gaps out boundary candles (returns null for first/last of
    // each day), so we use computeScalars to check the session VWAP value.
    // For a single-candle new day, the scalar is the typical price of that candle.
    const s = vwapPlugin.computeScalars(candles);
    expect(s.vwapSession).toBeCloseTo(200, 5);
    // Prev candle is still day 4 (price ~100); the series null-gaps at boundary
    // so prevVwap may be null. Verify the scalar diverges from day-4 territory.
    expect(s.vwapSession).toBeGreaterThan(150); // definitely not day-4 average
    void lastVwap; // used above; suppress unused warning
    void prevVwap;
  });

  test("hand-computed single-day VWAP matches", () => {
    const stepMs = 60_000;
    const fiveCandles = [
      { ts: 0 * stepMs, h: 102, l: 98, c: 100, v: 100 },  // typical = 100
      { ts: 1 * stepMs, h: 103, l: 99, c: 101, v: 200 },  // typical = 101
      { ts: 2 * stepMs, h: 105, l: 101, c: 103, v: 300 }, // typical = 103
      { ts: 3 * stepMs, h: 104, l: 100, c: 102, v: 100 }, // typical = 102
      { ts: 4 * stepMs, h: 106, l: 102, c: 104, v: 400 }, // typical = 104
    ];
    // Hand math: cumPV = 10000+20200+30900+10200+41600 = 112900; cumV = 1100.
    const expectedVwap = 112900 / 1100;

    const candles = fiveCandles.map((s) => ({
      timestamp: new Date(s.ts),
      open: s.c,
      high: s.h,
      low: s.l,
      close: s.c,
      volume: s.v,
    }));
    for (let i = 5; i < 220; i++) {
      candles.push({
        timestamp: new Date(i * stepMs),
        open: 104,
        high: 105,
        low: 103,
        close: 104,
        volume: 100,
      });
    }
    const raw = vwapPlugin.computeSeries(candles);
    if (raw.kind !== "lines") throw new Error("expected lines kind");
    // Index 4 is the last of the five hand-computed candles; the series may
    // null-gap boundary points, but index 4 is interior (not at a day boundary).
    const v4 = raw.series.vwap[4];
    expect(v4).not.toBeNull();
    expect(v4 as number).toBeCloseTo(expectedVwap, 6);
  });
});
