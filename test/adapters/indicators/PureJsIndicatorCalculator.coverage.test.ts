import { describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";

const calc = new PureJsIndicatorCalculator();
const registry = new IndicatorRegistry();
const allPlugins = registry.resolveActive(
  Object.fromEntries(registry.all().map((p) => [p.id, { enabled: true }])),
);

/**
 * Build candles whose closes match the given array. OHLV is deterministic.
 * Timestamps step by 15min (900_000 ms) — comfortably within one UTC day for
 * up to ~96 candles, so by default many candles share the same UTC day.
 */
function fromCloses(
  closes: number[],
  opts: { stepMs?: number; startMs?: number; volume?: number | ((i: number) => number) } = {},
): Candle[] {
  const { stepMs = 900_000, startMs = 0, volume = 100 } = opts;
  return closes.map((close, i) => ({
    timestamp: new Date(startMs + i * stepMs),
    open: i === 0 ? close : (closes[i - 1] ?? close),
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: typeof volume === "function" ? volume(i) : volume,
  }));
}

/** Pad a short closes array up to length 200 with the first value. */
function padTo(closes: number[], n: number): number[] {
  if (closes.length >= n) return closes;
  const first = closes[0] ?? 0;
  return [...Array(n - closes.length).fill(first), ...closes];
}

// ─── Bollinger Bands ────────────────────────────────────────────────────────

describe("Bollinger Bands — deeper coverage", () => {
  test("upper - middle ≈ 2 * population std (sample matches reference math)", async () => {
    // The last 20 closes are the only ones that drive bbMiddle/std. Pad the
    // earlier closes with that same value so the trailing 20 dominate.
    const last20 = [
      98, 99, 100, 101, 102, 98, 99, 100, 101, 102, 98, 99, 100, 101, 102, 98, 99, 100, 101, 102,
    ];
    // Hand math: mean = 100. Variance (population, n=20) = sum((x-100)^2)/20.
    // (98-100)^2*4 + (99-100)^2*4 + (100-100)^2*4 + (101-100)^2*4 + (102-100)^2*4
    // = 16+4+0+4+16 = 40; over 5 distinct → ×4 → 40. /20 = 2. std = sqrt(2).
    const std = Math.sqrt(2);
    const closes = padTo(last20, 220);
    const candles = fromCloses(closes);
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    expect(ind.bbMiddle).toBeCloseTo(100, 5);
    expect((ind.bbUpper as number) - (ind.bbMiddle as number)).toBeCloseTo(2 * std, 4);
    expect((ind.bbMiddle as number) - (ind.bbLower as number)).toBeCloseTo(2 * std, 4);
  });

  test("bbBandwidthPct equals (upper-lower)/middle*100", async () => {
    const last20 = [
      98, 99, 100, 101, 102, 98, 99, 100, 101, 102, 98, 99, 100, 101, 102, 98, 99, 100, 101, 102,
    ];
    const candles = fromCloses(padTo(last20, 220));
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    const expected = (((ind.bbUpper as number) - (ind.bbLower as number)) / (ind.bbMiddle as number)) * 100;
    expect(ind.bbBandwidthPct).toBeCloseTo(expected, 4);
  });

  test("constant series → upper === middle === lower, bandwidth = 0", async () => {
    const candles = fromCloses(Array(220).fill(100));
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    expect(ind.bbUpper).toBeCloseTo(ind.bbMiddle as number, 8);
    expect(ind.bbLower).toBeCloseTo(ind.bbMiddle as number, 8);
    expect(ind.bbBandwidthPct).toBeCloseTo(0, 8);
  });

  test("bandwidth tracks volatility regime — high-vol > low-vol", async () => {
    // Deterministic pseudo-random generator shared across both regimes so the
    // only differentiator is the noise amplitude.
    const makeRand = (seedInit: number) => {
      let seed = seedInit;
      return () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };
    };
    // Low-vol regime: ±0.1 around 100. The trailing 20 closes drive bbMiddle
    // and the std component of bandwidth, so we just need the FINAL window
    // of the series to sit in the relevant regime.
    const randLow = makeRand(7);
    const lowClosesAll = Array.from({ length: 250 }, () => 100 + (randLow() - 0.5) * 0.2);
    const indLow = await calc.compute(fromCloses(lowClosesAll), allPlugins) as Record<string, unknown>;

    // High-vol regime: ±5 around 100, same length.
    const randHigh = makeRand(7);
    const highClosesAll = Array.from({ length: 250 }, () => 100 + (randHigh() - 0.5) * 10);
    const indHigh = await calc.compute(fromCloses(highClosesAll), allPlugins) as Record<string, unknown>;

    // Sanity: both bandwidths are well-defined and non-negative.
    expect(indLow.bbBandwidthPct).toBeGreaterThanOrEqual(0);
    expect(indHigh.bbBandwidthPct).toBeGreaterThanOrEqual(0);
    // The high-vol series must produce a meaningfully larger bandwidth.
    // With amplitudes 0.2 vs 10 (50x), the ratio in bandwidth should be very
    // large; we conservatively require at least 10x.
    expect(indHigh.bbBandwidthPct).toBeGreaterThan((indLow.bbBandwidthPct as number) * 10);
  });
});

// ─── MACD ───────────────────────────────────────────────────────────────────
// NOTE: Tests using computeSeries (histogram identity, sign flip, sine cycling)
// are ported to test/adapters/indicators/plugins/macd/index.test.ts.

describe("MACD — deeper coverage", () => {
  test("accelerating downtrend → macd < 0, signal < 0, macd more negative than signal", async () => {
    // For a series whose downtrend ACCELERATES at the end, the MACD line drops
    // faster than its 9-period EMA smoothing → macd < signal → hist < 0,
    // and |macd| > |signal|.
    //
    // Note: on a perfectly LINEAR fall the EMA-of-EMA reaches steady-state
    // where macd === signal exactly (no acceleration to chase). We build
    // a quadratic acceleration to get the strict inequality.
    const closes = Array.from({ length: 250 }, (_, i) => 200 - 0.005 * i * i);
    const candles = fromCloses(closes);
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    expect(ind.macd).toBeLessThan(0);
    expect(ind.macdSignal).toBeLessThan(0);
    expect(ind.macd).toBeLessThan(ind.macdSignal as number); // macd more negative than its smoothing
    expect(ind.macdHist).toBeLessThan(0);
  });
});

// ─── ATR Z-score (200) ──────────────────────────────────────────────────────

describe("ATR Z-score (200) — deeper coverage", () => {
  test("contraction at the end → atrZScore200 < -1", async () => {
    // First 180 candles: wide range (high vol). Last 20: tight range (low vol).
    const candles: Candle[] = [];
    for (let i = 0; i < 230; i++) {
      const tight = i >= 210; // last 20
      const range = tight ? 0.1 : 5;
      candles.push({
        timestamp: new Date(i * 900_000),
        open: 100,
        high: 100 + range,
        low: 100 - range,
        close: 100,
        volume: 100,
      });
    }
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    expect(ind.atrZScore200).toBeLessThan(-1);
  });

  test("expansion at the end → atrZScore200 > 1", async () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 230; i++) {
      const wide = i >= 210; // last 20
      const range = wide ? 10 : 0.1;
      candles.push({
        timestamp: new Date(i * 900_000),
        open: 100,
        high: 100 + range,
        low: 100 - range,
        close: 100,
        volume: 100,
      });
    }
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    expect(ind.atrZScore200).toBeGreaterThan(1);
  });

  test("z-score uses sample variance (n-1), not population", async () => {
    // Build a series of 220 candles where TRs are essentially constant for 200
    // candles, then a known different last value. With the EMA-style smoothed
    // ATR, the last ATR diverges from the mean by a known amount; we just
    // verify the sign and magnitude is consistent with sample-stddev (n-1).
    //
    // Concrete approach: 218 candles with high-low = 2 (TR=2), then the last
    // 2 candles with high-low = 6 (TR=6). The rolling ATR(14) will rise from
    // 2 toward 6 but only fractionally on the last bar (Wilder smoothing).
    // The z-score then = (atrLast - mean(window)) / sampleStd(window).
    //
    // Population stddev (divide by n) is always less than or equal to sample
    // stddev (divide by n-1). For a series this large (n≈207 ATR points),
    // the difference is small but the sample formula gives a slightly SMALLER
    // |z| than population would. We just assert correctness against a manual
    // computation matching the sample formula.
    const candles: Candle[] = [];
    for (let i = 0; i < 220; i++) {
      const wide = i >= 218;
      const range = wide ? 3 : 1; // TR = 2*range when prev close = 100
      candles.push({
        timestamp: new Date(i * 900_000),
        open: 100,
        high: 100 + range,
        low: 100 - range,
        close: 100,
        volume: 100,
      });
    }
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    // Reproduce the calculator's ATR series by hand (Wilder smoothing on TRs).
    // TR[i] = high - low for all i (close stays at 100, so no gap). For our
    // construction TR is 2 for i<218 and 6 for i>=218.
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i]!;
      const cPrev = candles[i - 1]!;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - cPrev.close), Math.abs(c.low - cPrev.close));
      trs.push(tr);
    }
    const atrSeries: number[] = [];
    let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
    atrSeries.push(atr);
    for (let i = 14; i < trs.length; i++) {
      atr = (atr * 13 + trs[i]!) / 14;
      atrSeries.push(atr);
    }
    const window = atrSeries.slice(-200);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance =
      window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(window.length - 1, 1);
    const sampleStd = Math.sqrt(variance);
    const last = window[window.length - 1]!;
    const expectedZ = sampleStd === 0 ? 0 : (last - mean) / sampleStd;
    expect(ind.atrZScore200).toBeCloseTo(expectedZ, 5);
  });
});

// ─── VWAP (session) ─────────────────────────────────────────────────────────
// NOTE: Tests using computeSeries (midnight reset, hand-computed VWAP at index 4)
// are ported to test/adapters/indicators/plugins/vwap/index.test.ts.

describe("VWAP (session) — deeper coverage", () => {
  test("heavy-volume bar pulls VWAP toward its price", async () => {
    // Single-day session of 250 candles, all 1h spacing inside one day. To
    // stay in one day with 250 candles, we'd need a longer day — instead,
    // shrink stepMs to 5min so 250 * 5min = ~20h, well within one UTC day.
    const stepMs = 5 * 60 * 1000;
    const ms = 86_400_000;
    // Anchor start at day 0, midnight, so all candles share day 0.
    const baseDayStart = 0;
    const candles: Candle[] = [];
    for (let i = 0; i < 250; i++) {
      const ts = baseDayStart + i * stepMs;
      // Most candles trade at price 100 with vol=100.
      // Inject one heavy candle at index 245 trading at price 50 with vol=1000.
      const isHeavy = i === 245;
      const price = isHeavy ? 50 : 100;
      const vol = isHeavy ? 10000 : 100;
      candles.push({
        timestamp: new Date(ts),
        open: price,
        high: price + 0.5,
        low: price - 0.5,
        close: price,
        volume: vol,
      });
    }
    // Verify all inside day 0.
    expect(Math.floor(candles[candles.length - 1]!.timestamp.getTime() / ms)).toBe(0);

    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    // Hand math: 249 normal bars (typical=100, vol=100) + 1 heavy bar
    // (typical=50, vol=10_000).
    //   PV = 249 * 100 * 100 + 50 * 10_000 = 2_490_000 + 500_000 = 2_990_000
    //   V  = 249 * 100        + 10_000     = 24_900    + 10_000  = 34_900
    //   VWAP = 2_990_000 / 34_900 ≈ 85.6733
    expect(ind.vwapSession).toBeCloseTo(2_990_000 / 34_900, 1);
  });

});

// ─── POC (Point of Control) ─────────────────────────────────────────────────

describe("POC — deeper coverage", () => {
  test("concentration zone — POC falls inside the heavy [99, 101] range", async () => {
    // POC uses the LAST 50 candles of the input. Build 200 padding candles
    // (uniform, low vol) then 50 candles where 80% of total volume sits in
    // [99, 101] and 20% spreads across [90, 110].
    const candles: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      candles.push({
        timestamp: new Date(i * 900_000),
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 1, // negligible
      });
    }
    // 50 "recent" candles: 40 with volume 1000 in tight [99,101], 10 with
    // volume 250 spread across [90,110]. Total heavy vol = 40k vs spread vol
    // = 2.5k → heavy zone dominates.
    for (let i = 0; i < 40; i++) {
      candles.push({
        timestamp: new Date((200 + i) * 900_000),
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1000,
      });
    }
    for (let i = 0; i < 10; i++) {
      // spread bars go from 90 to 110 in their own range
      candles.push({
        timestamp: new Date((240 + i) * 900_000),
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 250,
      });
    }
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    expect(ind.pocPrice).toBeGreaterThanOrEqual(99);
    expect(ind.pocPrice).toBeLessThanOrEqual(101);
  });

  test("bimodal — POC sits at the higher-volume node, not in between", async () => {
    // Build 250 candles. Last 50: two volume nodes — one around 100 (low
    // total volume) and one around 110 (high total volume). POC should be
    // near 110.
    const candles: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      candles.push({
        timestamp: new Date(i * 900_000),
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 1,
      });
    }
    // 25 candles around 100 with vol 100; 25 around 110 with vol 1000.
    for (let i = 0; i < 25; i++) {
      candles.push({
        timestamp: new Date((200 + i) * 900_000),
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 100,
      });
    }
    for (let i = 0; i < 25; i++) {
      candles.push({
        timestamp: new Date((225 + i) * 900_000),
        open: 110,
        high: 110.5,
        low: 109.5,
        close: 110,
        volume: 1000,
      });
    }
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    // Expect POC clearly in the upper node.
    expect(ind.pocPrice).toBeGreaterThan(108);
    expect(ind.pocPrice).toBeLessThanOrEqual(111);
  });

  test("POC sits within candle high/low range when only one bar dominates", async () => {
    // 250 candles, the LAST 50 are all the same single bar at price ~100.
    // POC must be within that bar's range (99.5 to 100.5) — sensible value.
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 100,
    }));
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    expect(ind.pocPrice).toBeGreaterThanOrEqual(99.5);
    expect(ind.pocPrice).toBeLessThanOrEqual(100.5);
  });
});

// NOTE: "FVG — deeper coverage" tests are ported to
// test/adapters/indicators/plugins/structure_levels/index.test.ts
// (FVG detection is now exposed via detectFvgs from the base math module,
// consumed by the structure_levels plugin; series.fvgs no longer exists on
// the calculator-level computeSeries output).
