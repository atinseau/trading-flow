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

  test("RSI of strictly rising series tends to >70", async () => {
    const candles = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 3600_000),
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 101 + i,
      volume: 100,
    }));
    const ind = await calc.compute(candles);
    expect(ind.rsi).toBeGreaterThan(70);
  });

  test("RSI of strictly falling series tends to <30", async () => {
    const candles = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(i * 3600_000),
      open: 500 - i,
      high: 501 - i,
      low: 498 - i,
      close: 499 - i,
      volume: 100,
    }));
    const ind = await calc.compute(candles);
    expect(ind.rsi).toBeLessThan(30);
  });
});
