import { describe, expect, test } from "bun:test";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";

const calc = new PureJsIndicatorCalculator();

function syntheticCandles(
  n: number,
  opts: {
    base?: number;
    vol?: number;
    drift?: number;
    noiseSeed?: number;
  } = {},
): Candle[] {
  const { base = 100, vol = 100, drift = 0, noiseSeed = 1 } = opts;
  // Deterministic pseudo-random — same inputs always produce same series.
  let seed = noiseSeed;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const out: Candle[] = [];
  let close = base;
  for (let i = 0; i < n; i++) {
    const noise = (rand() - 0.5) * 2;
    close = Math.max(1, close + drift + noise);
    const high = close + Math.abs(noise) + 0.5;
    const low = close - Math.abs(noise) - 0.5;
    out.push({
      timestamp: new Date(i * 900_000),
      open: close - drift,
      high,
      low,
      close,
      volume: vol + Math.abs(noise) * 10,
    });
  }
  return out;
}

describe("PureJsIndicatorCalculator — extended indicators", () => {
  test("VWAP sits between candle low and high (sanity)", async () => {
    const candles = syntheticCandles(250);
    const ind = await calc.compute(candles);
    const last = candles[candles.length - 1];
    expect(last).toBeDefined();
    if (!last) return;
    // VWAP should be within the broader recent price range, not literally
    // bounded by a single candle.
    const recentHigh = Math.max(...candles.slice(-30).map((c) => c.high));
    const recentLow = Math.min(...candles.slice(-30).map((c) => c.low));
    expect(ind.vwapSession).toBeGreaterThanOrEqual(recentLow);
    expect(ind.vwapSession).toBeLessThanOrEqual(recentHigh);
  });

  test("Bollinger middle equals SMA20 by construction", async () => {
    const candles = syntheticCandles(250);
    const ind = await calc.compute(candles);
    const closes = candles.slice(-20).map((c) => c.close);
    const sma20 = closes.reduce((a, b) => a + b, 0) / 20;
    expect(ind.bbMiddle).toBeCloseTo(sma20, 5);
    expect(ind.bbUpper).toBeGreaterThan(ind.bbMiddle);
    expect(ind.bbLower).toBeLessThan(ind.bbMiddle);
    expect(ind.bbBandwidthPct).toBeGreaterThan(0);
  });

  test("MACD on a flat series is zero", async () => {
    const candles = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
      volume: 100,
    }));
    const ind = await calc.compute(candles);
    expect(ind.macd).toBeCloseTo(0, 5);
    expect(ind.macdSignal).toBeCloseTo(0, 5);
    expect(ind.macdHist).toBeCloseTo(0, 5);
  });

  test("MACD positive on a strictly rising series", async () => {
    const candles = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 101 + i,
      volume: 100,
    }));
    const ind = await calc.compute(candles);
    expect(ind.macd).toBeGreaterThan(0);
    expect(ind.macdSignal).toBeGreaterThan(0);
  });

  test("ATR Z-score is 0 when ATR series is constant", async () => {
    const candles = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    const ind = await calc.compute(candles);
    expect(ind.atrZScore200).toBeCloseTo(0, 5);
  });

  test("Swing detection finds the obvious peak in a triangle wave", async () => {
    const candles: Candle[] = [];
    // 250 candles forming a tent: rise from 100 to 200, fall back to 100.
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
    const series = await calc.computeSeries(candles);
    // Should detect at least one swing high near the top.
    expect(series.swingHighs.length).toBeGreaterThan(0);
    const topIdx = series.swingHighs[series.swingHighs.length - 1]?.index ?? -1;
    expect(topIdx).toBeGreaterThan(120);
    expect(topIdx).toBeLessThan(135);
  });

  test("FVG detection finds a 3-candle gap up", async () => {
    // Build a 250-candle baseline of stable values, then inject a clear gap up
    // at indices 100-102 (candle 100's high < candle 102's low).
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    candles[100] = { ...candles[100]!, high: 100, low: 99, close: 99.5 };
    candles[101] = { ...candles[101]!, high: 110, low: 105, close: 109 };
    candles[102] = { ...candles[102]!, high: 112, low: 108, close: 110 };

    const series = await calc.computeSeries(candles);
    const bullishFvg = series.fvgs.find((f) => f.direction === "bullish" && f.index === 101);
    expect(bullishFvg).toBeDefined();
    if (bullishFvg) {
      // Gap is between candles[100].high (=100) and candles[102].low (=108).
      expect(bullishFvg.bottom).toBeCloseTo(100, 1);
      expect(bullishFvg.top).toBeCloseTo(108, 1);
    }
  });

  test("BOS state goes bullish when price closes above prior swing high", async () => {
    // Build a series with a clean swing high at index 50, then a strong run-up
    // that closes well above that high.
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push({
        timestamp: new Date(i * 900_000),
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 100,
      });
    }
    // Bump up
    for (let i = 0; i < 5; i++) {
      candles.push({
        timestamp: new Date((30 + i) * 900_000),
        open: 100 + i * 2,
        high: 105 + i * 2,
        low: 99 + i * 2,
        close: 104 + i * 2,
        volume: 100,
      });
    }
    // Pullback creating a swing high around 113
    for (let i = 0; i < 10; i++) {
      candles.push({
        timestamp: new Date((35 + i) * 900_000),
        open: 113 - i,
        high: 114 - i,
        low: 110 - i,
        close: 112 - i,
        volume: 100,
      });
    }
    // Now break above with momentum
    for (let i = 0; i < 205; i++) {
      candles.push({
        timestamp: new Date((45 + i) * 900_000),
        open: 102 + i,
        high: 105 + i,
        low: 100 + i,
        close: 104 + i,
        volume: 100,
      });
    }
    const ind = await calc.compute(candles);
    expect(ind.bosState).toBe("bullish");
  });

  test("Equal highs detected when 2+ swing highs cluster within tolerance", async () => {
    // Build a series with three crisp single-bar peaks at ~110 separated by
    // wider troughs near 100. The peaks are strict local maxima (single bar
    // higher than neighbours), and within 0.1% of each other → should cluster
    // into one equal-high group.
    const candles: Candle[] = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 900_000),
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 100,
    }));
    // Peaks placed inside the calculator's RECENT_WINDOW (last 50 candles, so
    // indices 200..247 with safe lookback).
    for (const i of [210, 225, 240]) {
      candles[i] = {
        timestamp: new Date(i * 900_000),
        open: 100,
        high: 110.05 + Math.random() * 0.02,
        low: 100,
        close: 110,
        volume: 100,
      };
    }
    const ind = await calc.compute(candles);
    expect(ind.equalHighsCount).toBeGreaterThanOrEqual(2);
  });

  test("POC is within candle range", async () => {
    const candles = syntheticCandles(250);
    const ind = await calc.compute(candles);
    const minLow = Math.min(...candles.slice(-50).map((c) => c.low));
    const maxHigh = Math.max(...candles.slice(-50).map((c) => c.high));
    expect(ind.pocPrice).toBeGreaterThanOrEqual(minLow);
    expect(ind.pocPrice).toBeLessThanOrEqual(maxHigh);
  });

  test("computeSeries arrays are aligned with candle count", async () => {
    const candles = syntheticCandles(250);
    const series = await calc.computeSeries(candles);
    expect(series.ema20.length).toBe(250);
    expect(series.vwap.length).toBe(250);
    expect(series.bbUpper.length).toBe(250);
    expect(series.macd.length).toBe(250);
    expect(series.rsi.length).toBe(250);
  });
});
