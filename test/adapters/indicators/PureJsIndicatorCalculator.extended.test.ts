import { describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";

const calc = new PureJsIndicatorCalculator();
const registry = new IndicatorRegistry();
const allPlugins = registry.resolveActive(
  Object.fromEntries(registry.all().map((p) => [p.id, { enabled: true }])),
);

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
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
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
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    const closes = candles.slice(-20).map((c) => c.close);
    const sma20 = closes.reduce((a, b) => a + b, 0) / 20;
    expect(ind.bbMiddle).toBeCloseTo(sma20, 5);
    expect(ind.bbUpper).toBeGreaterThan(ind.bbMiddle as number);
    expect(ind.bbLower).toBeLessThan(ind.bbMiddle as number);
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
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
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
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
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
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    expect(ind.atrZScore200).toBeCloseTo(0, 5);
  });

  // NOTE: "Swing detection finds the obvious peak" is ported to
  // test/adapters/indicators/plugins/swings_bos/index.test.ts

  // NOTE: "FVG detection finds a 3-candle gap up" is ported to
  // test/adapters/indicators/plugins/structure_levels/index.test.ts

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
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
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
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    expect(ind.equalHighsCount).toBeGreaterThanOrEqual(2);
  });

  test("POC is within candle range", async () => {
    const candles = syntheticCandles(250);
    const ind = await calc.compute(candles, allPlugins) as Record<string, unknown>;
    const minLow = Math.min(...candles.slice(-50).map((c) => c.low));
    const maxHigh = Math.max(...candles.slice(-50).map((c) => c.high));
    expect(ind.pocPrice).toBeGreaterThanOrEqual(minLow);
    expect(ind.pocPrice).toBeLessThanOrEqual(maxHigh);
  });

  test("computeSeries arrays are aligned with candle count", async () => {
    // After modularisation, computeSeries returns Record<pluginId, IndicatorSeriesContribution>.
    // Each plugin's series arrays must be aligned with the candle count (length=250).
    const candles = syntheticCandles(250);
    const seriesMap = await calc.computeSeries(candles, allPlugins);

    // ema_stack plugin: lines kind — emaShort/emaMid/emaLong arrays
    const emaContrib = seriesMap["ema_stack"];
    expect(emaContrib?.kind).toBe("lines");
    if (emaContrib?.kind === "lines") {
      expect(emaContrib.series["emaShort"]?.length).toBe(250);
    }

    // vwap plugin: lines kind with vwap series
    const vwapContrib = seriesMap["vwap"];
    expect(vwapContrib?.kind).toBe("lines");
    if (vwapContrib?.kind === "lines") {
      expect(vwapContrib.series["vwap"]?.length).toBe(250);
    }

    // bollinger plugin: lines kind — upper/middle/lower arrays
    const bbContrib = seriesMap["bollinger"];
    expect(bbContrib?.kind).toBe("lines");
    if (bbContrib?.kind === "lines") {
      expect(bbContrib.series["upper"]?.length).toBe(250);
    }

    // macd plugin: lines kind with macd/signal/hist series
    const macdContrib = seriesMap["macd"];
    expect(macdContrib?.kind).toBe("lines");
    if (macdContrib?.kind === "lines") {
      expect(macdContrib.series["macd"]?.length).toBe(250);
    }

    // rsi plugin: lines kind with rsi series
    const rsiContrib = seriesMap["rsi"];
    expect(rsiContrib?.kind).toBe("lines");
    if (rsiContrib?.kind === "lines") {
      expect(rsiContrib.series["rsi"]?.length).toBe(250);
    }
  });
});
