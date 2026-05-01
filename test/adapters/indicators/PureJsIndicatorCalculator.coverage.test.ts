import { describe, expect, test } from "bun:test";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";

const calc = new PureJsIndicatorCalculator();

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
    const ind = await calc.compute(candles);
    expect(ind.bbMiddle).toBeCloseTo(100, 5);
    expect(ind.bbUpper - ind.bbMiddle).toBeCloseTo(2 * std, 4);
    expect(ind.bbMiddle - ind.bbLower).toBeCloseTo(2 * std, 4);
  });

  test("bbBandwidthPct equals (upper-lower)/middle*100", async () => {
    const last20 = [
      98, 99, 100, 101, 102, 98, 99, 100, 101, 102, 98, 99, 100, 101, 102, 98, 99, 100, 101, 102,
    ];
    const candles = fromCloses(padTo(last20, 220));
    const ind = await calc.compute(candles);
    const expected = ((ind.bbUpper - ind.bbLower) / ind.bbMiddle) * 100;
    expect(ind.bbBandwidthPct).toBeCloseTo(expected, 4);
  });

  test("constant series → upper === middle === lower, bandwidth = 0", async () => {
    const candles = fromCloses(Array(220).fill(100));
    const ind = await calc.compute(candles);
    expect(ind.bbUpper).toBeCloseTo(ind.bbMiddle, 8);
    expect(ind.bbLower).toBeCloseTo(ind.bbMiddle, 8);
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
    const indLow = await calc.compute(fromCloses(lowClosesAll));

    // High-vol regime: ±5 around 100, same length.
    const randHigh = makeRand(7);
    const highClosesAll = Array.from({ length: 250 }, () => 100 + (randHigh() - 0.5) * 10);
    const indHigh = await calc.compute(fromCloses(highClosesAll));

    // Sanity: both bandwidths are well-defined and non-negative.
    expect(indLow.bbBandwidthPct).toBeGreaterThanOrEqual(0);
    expect(indHigh.bbBandwidthPct).toBeGreaterThanOrEqual(0);
    // The high-vol series must produce a meaningfully larger bandwidth.
    // With amplitudes 0.2 vs 10 (50x), the ratio in bandwidth should be very
    // large; we conservatively require at least 10x.
    expect(indHigh.bbBandwidthPct).toBeGreaterThan(indLow.bbBandwidthPct * 10);
  });
});

// ─── MACD ───────────────────────────────────────────────────────────────────

describe("MACD — deeper coverage", () => {
  test("histogram === macd - signal across many indices", async () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.05);
    const candles = fromCloses(closes);
    const series = await calc.computeSeries(candles);
    let checked = 0;
    for (let i = 0; i < series.macd.length; i++) {
      const m = series.macd[i];
      const s = series.macdSignal[i];
      const h = series.macdHist[i];
      if (m == null || s == null || h == null) continue;
      expect(h).toBeCloseTo(m - s, 8);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("histogram flips negative → positive across a downtrend-to-uptrend pivot", async () => {
    // 150 candles of falling closes, then 100 of rising closes ending at the latest.
    const closes: number[] = [];
    for (let i = 0; i < 150; i++) closes.push(200 - i * 0.5);
    for (let i = 0; i < 100; i++) closes.push(125 + i * 0.8);
    const candles = fromCloses(closes);
    const series = await calc.computeSeries(candles);
    // Find a point well into the downtrend where hist is negative.
    const downIdx = 130;
    const downHist = series.macdHist[downIdx];
    expect(downHist).not.toBeNull();
    expect(downHist as number).toBeLessThan(0);
    // By the end of the uptrend, hist should have flipped positive.
    const lastHist = series.macdHist[series.macdHist.length - 1];
    expect(lastHist).not.toBeNull();
    expect(lastHist as number).toBeGreaterThan(0);
  });

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
    const ind = await calc.compute(candles);
    expect(ind.macd).toBeLessThan(0);
    expect(ind.macdSignal).toBeLessThan(0);
    expect(ind.macd).toBeLessThan(ind.macdSignal); // macd more negative than its smoothing
    expect(ind.macdHist).toBeLessThan(0);
  });

  test("cycling sine series → macd takes both positive and negative values", async () => {
    const closes = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 10) * 5);
    const candles = fromCloses(closes);
    const series = await calc.computeSeries(candles);
    let posCount = 0;
    let negCount = 0;
    for (const v of series.macd) {
      if (v == null) continue;
      if (v > 0.01) posCount++;
      else if (v < -0.01) negCount++;
    }
    expect(posCount).toBeGreaterThan(20);
    expect(negCount).toBeGreaterThan(20);
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
    const ind = await calc.compute(candles);
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
    const ind = await calc.compute(candles);
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
    const ind = await calc.compute(candles);
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

describe("VWAP (session) — deeper coverage", () => {
  test("VWAP resets at UTC midnight (just-after-midnight VWAP = first candle's typical price)", async () => {
    // Build 250 candles. The session reset uses Math.floor(ts / 86_400_000),
    // so a candle at exactly N * 86_400_000 lands on a fresh day.
    // We anchor the start so the second-to-last candle is just before midnight
    // and the last candle is just after.
    const ms = 86_400_000;
    // Need 250 candles ending in a fresh day. Use 1-hour spacing (3_600_000).
    // Place the boundary near the end:
    //  - last candle timestamp = 5*ms exactly (a midnight)
    //  - prior candle = 5*ms - 1h = day 4 (the last candle of day 4)
    // start = lastTs - 249 * 1h
    const lastTs = 5 * ms;
    const stepMs = 3_600_000;
    const startMs = lastTs - 249 * stepMs;
    const candles: Candle[] = [];
    for (let i = 0; i < 250; i++) {
      const ts = startMs + i * stepMs;
      // Distinct, large prices that make day-4 vs day-5 averages differ a lot.
      // Day 4 candles trade around 100; day 5 candle trades at 200.
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
    // Sanity: confirm the partition.
    const lastCandle = candles[candles.length - 1]!;
    const prevCandle = candles[candles.length - 2]!;
    expect(Math.floor(lastCandle.timestamp.getTime() / ms)).toBe(5);
    expect(Math.floor(prevCandle.timestamp.getTime() / ms)).toBe(4);

    const series = await calc.computeSeries(candles);
    const lastVwap = series.vwap[series.vwap.length - 1];
    const prevVwap = series.vwap[series.vwap.length - 2];
    expect(lastVwap).not.toBeNull();
    expect(prevVwap).not.toBeNull();
    // Just-before-midnight VWAP averages day 4 (price ~100). Just-after VWAP
    // is the new-day candle's typical price = 200. They must differ.
    expect(lastVwap as number).toBeCloseTo(200, 5);
    expect(prevVwap as number).toBeCloseTo(100, 5);
  });

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

    const ind = await calc.compute(candles);
    // Hand math: 249 normal bars (typical=100, vol=100) + 1 heavy bar
    // (typical=50, vol=10_000).
    //   PV = 249 * 100 * 100 + 50 * 10_000 = 2_490_000 + 500_000 = 2_990_000
    //   V  = 249 * 100        + 10_000     = 24_900    + 10_000  = 34_900
    //   VWAP = 2_990_000 / 34_900 ≈ 85.6733
    expect(ind.vwapSession).toBeCloseTo(2_990_000 / 34_900, 1);
  });

  test("hand-computed single-day VWAP matches", async () => {
    // 5 candles in day 0, then pad to 200 in day 0 to satisfy the 200-candle
    // requirement. We assert the VWAP at INDEX 4 via computeSeries (so the
    // padding-after doesn't pollute our hand math).
    const stepMs = 60_000;
    const fiveCandles = [
      { ts: 0 * stepMs, h: 102, l: 98, c: 100, v: 100 }, // typical = 100
      { ts: 1 * stepMs, h: 103, l: 99, c: 101, v: 200 }, // typical = 101
      { ts: 2 * stepMs, h: 105, l: 101, c: 103, v: 300 }, // typical = 103
      { ts: 3 * stepMs, h: 104, l: 100, c: 102, v: 100 }, // typical = 102
      { ts: 4 * stepMs, h: 106, l: 102, c: 104, v: 400 }, // typical = 104
    ];
    // Hand math:
    //  cumPV = 100*100 + 101*200 + 103*300 + 102*100 + 104*400
    //        = 10000 + 20200 + 30900 + 10200 + 41600 = 112900
    //  cumV  = 100 + 200 + 300 + 100 + 400 = 1100
    //  VWAP@4 = 112900 / 1100 = 102.6363636...
    const expectedVwap = 112900 / 1100;

    // Pad with extra candles AFTER, all in day 0 so they remain in the same
    // session. The assertion is on index 4.
    const candles: Candle[] = fiveCandles.map((s) => ({
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
    const series = await calc.computeSeries(candles);
    const v4 = series.vwap[4];
    expect(v4).not.toBeNull();
    expect(v4 as number).toBeCloseTo(expectedVwap, 6);
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
    const ind = await calc.compute(candles);
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
    const ind = await calc.compute(candles);
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
    const ind = await calc.compute(candles);
    expect(ind.pocPrice).toBeGreaterThanOrEqual(99.5);
    expect(ind.pocPrice).toBeLessThanOrEqual(100.5);
  });
});

// ─── FVG (Fair Value Gap) ───────────────────────────────────────────────────

describe("FVG — deeper coverage", () => {
  test("bearish FVG: candles[i-1].low > candles[i+1].high", async () => {
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    // Inject a bearish gap at indices 100-102:
    //  candles[100]: low = 110 (high = 112)
    //  candles[101]: middle / strong drop bar
    //  candles[102]: high = 105 (low = 103)
    // Gap exists if candles[100].low (=110) > candles[102].high (=105).
    candles[100] = {
      timestamp: candles[100]!.timestamp,
      open: 112,
      high: 112,
      low: 110,
      close: 110,
      volume: 100,
    };
    candles[101] = {
      timestamp: candles[101]!.timestamp,
      open: 110,
      high: 110,
      low: 105,
      close: 105,
      volume: 100,
    };
    candles[102] = {
      timestamp: candles[102]!.timestamp,
      open: 105,
      high: 105,
      low: 103,
      close: 103,
      volume: 100,
    };

    const series = await calc.computeSeries(candles);
    const bearish = series.fvgs.find((f) => f.direction === "bearish" && f.index === 101);
    expect(bearish).toBeDefined();
    if (bearish) {
      // Per implementation: top = a.low (=110), bottom = c.high (=105).
      expect(bearish.top).toBeCloseTo(110, 5);
      expect(bearish.bottom).toBeCloseTo(105, 5);
    }
  });

  test("no FVG on flat adjacent bars", async () => {
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    const series = await calc.computeSeries(candles);
    expect(series.fvgs.length).toBe(0);
  });

  test("two distinct FVGs detected and ordered by index", async () => {
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    // Bullish gap at i=51: c[52].low > c[50].high (102 > 101).
    // The inner bar c[51] is kept minimally distinct from neighbors so that
    // it does NOT form collateral gaps at i=50 or i=52. We also bridge the
    // step-down at i=53 by overlapping c[54]'s range with both c[52] and the
    // baseline — without that bridge, the elevated c[52] would gap against
    // baseline c[54], creating a spurious bearish FVG at i=53.
    //   c[49] baseline: high=101, low=99
    //   c[51]: high=102, low=100.5 → c[49].high≥c[51].low and c[51].high≥c[49].low
    //   c[53] baseline: high=101, low=99 (no gap with c[51])
    //   c[54] bridge: high=102, low=101 (overlaps c[52]=102..103 and c[56]=99..101)
    candles[50] = { ...candles[50]!, high: 101, low: 99, close: 100 };
    candles[51] = { ...candles[51]!, open: 101, high: 102, low: 100.5, close: 101.5 };
    candles[52] = { ...candles[52]!, open: 102, high: 103, low: 102, close: 102.5 };
    candles[54] = { ...candles[54]!, open: 102, high: 102, low: 101, close: 101.5 };
    // Bearish gap at i=151: c[152].high < c[150].low (98 < 99). Symmetric
    // construction with a bridging c[154] to avoid a spurious bullish FVG
    // at i=153 (where the depressed c[152] would otherwise gap up against
    // baseline c[154]).
    //   c[151]: high=100, low=99.5 (minimally distinct from baseline neighbors)
    //   c[154] bridge: high=99, low=98 (overlaps c[152]=97..98 and c[156]=99..101)
    candles[150] = { ...candles[150]!, open: 100, high: 101, low: 99, close: 99.5 };
    candles[151] = { ...candles[151]!, open: 99.5, high: 100, low: 99.5, close: 99.5 };
    candles[152] = { ...candles[152]!, open: 98, high: 98, low: 97, close: 97.5 };
    candles[154] = { ...candles[154]!, open: 98, high: 99, low: 98, close: 98.5 };

    const series = await calc.computeSeries(candles);
    // Enforce the "exactly two" claim made by the test name.
    expect(series.fvgs.length).toBe(2);
    const bullish = series.fvgs.find((f) => f.direction === "bullish" && f.index === 51);
    const bearish = series.fvgs.find((f) => f.direction === "bearish" && f.index === 151);
    expect(bullish).toBeDefined();
    expect(bearish).toBeDefined();
    // Detection scans candles in ascending order, so the bullish (i=51) FVG
    // should appear before the bearish (i=151) one in the output.
    const idxBull = series.fvgs.indexOf(bullish!);
    const idxBear = series.fvgs.indexOf(bearish!);
    expect(idxBull).toBeLessThan(idxBear);
  });

  test("touching but not gapping (a.high === c.low) → NOT detected as FVG", async () => {
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    // a.high = 101, c.low = 101 (touching). Bullish requires c.low > a.high.
    candles[100] = { ...candles[100]!, high: 101, low: 99, close: 100 };
    candles[101] = { ...candles[101]!, high: 105, low: 101, close: 104 };
    candles[102] = { ...candles[102]!, high: 106, low: 101, close: 105 };
    const series = await calc.computeSeries(candles);
    const fvg = series.fvgs.find((f) => f.index === 101);
    expect(fvg).toBeUndefined();
  });
});
