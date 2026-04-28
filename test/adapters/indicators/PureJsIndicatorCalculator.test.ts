import { describe, expect, test } from "bun:test";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import { FakeMarketDataFetcher } from "@test-fakes/FakeMarketDataFetcher";

describe("PureJsIndicatorCalculator", () => {
  const calc = new PureJsIndicatorCalculator();

  test("computes valid indicators on synthetic 250-candle series", async () => {
    const candles = FakeMarketDataFetcher.generateLinear(250, 100);
    const ind = await calc.compute(candles);
    expect(ind.rsi).toBeGreaterThanOrEqual(0);
    expect(ind.rsi).toBeLessThanOrEqual(100);
    expect(ind.ema20).toBeGreaterThan(0);
    expect(ind.ema50).toBeGreaterThan(0);
    expect(ind.ema200).toBeGreaterThan(0);
    expect(ind.atr).toBeGreaterThan(0);
    expect(ind.recentHigh).toBeGreaterThanOrEqual(ind.recentLow);
  });

  test("RSI of strictly rising series equals 100 (Wilder's smoothed)", async () => {
    // Strictly rising: no losses ever → avgLoss = 0 → RSI = 100.
    const candles = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 3600_000),
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 101 + i,
      volume: 100,
    }));
    const ind = await calc.compute(candles);
    expect(ind.rsi).toBeCloseTo(100, 5);
  });

  test("RSI of strictly falling series equals 0 (Wilder's smoothed)", async () => {
    // Strictly falling: no gains ever → avgGain = 0 → RSI = 0.
    const candles = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 3600_000),
      open: 500 - i,
      high: 501 - i,
      low: 498 - i,
      close: 499 - i,
      volume: 100,
    }));
    const ind = await calc.compute(candles);
    expect(ind.rsi).toBeCloseTo(0, 5);
  });
});
