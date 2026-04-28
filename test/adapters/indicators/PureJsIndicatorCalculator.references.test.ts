import { describe, expect, test } from "bun:test";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";

const calc = new PureJsIndicatorCalculator();

/**
 * Helper: build a candle list with closes from an array, deterministic OHLV.
 */
function fromCloses(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    timestamp: new Date(2026, 0, 1, 0, i),
    open: i === 0 ? close : closes[i - 1]!,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 100,
  }));
}

describe("PureJsIndicatorCalculator reference values", () => {
  test("RSI(14) on Investopedia worked example (after 200-pad warmup)", async () => {
    // Classic textbook example for RSI calculation.
    // Source: Investopedia RSI worked example, period 14.
    // Implementation uses Wilder's smoothed average (TA-Lib / TradingView conformant).
    //
    // Note: the textbook RSI on the raw 33 closes is ~37.77, but our calculator
    // requires 200+ closes for ema200, so we left-pad with the first close.
    // Wilder's smoothing applied to the long flat prefix drives avgGain/avgLoss
    // toward zero before the actual data kicks in, so the empirical RSI on this
    // padded dataset is ~35.51 (not the textbook 37.77). Bounds are tight (±1)
    // around this empirical value since Wilder's smoothing is deterministic.
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
      46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35,
      44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
    ];

    // Pad to 200+ closes (calculator requires it).
    const padded = [...Array(200 - closes.length).fill(closes[0]!), ...closes];
    const candles = fromCloses(padded);

    const ind = await calc.compute(candles);

    // Empirical reference value: Wilder's smoothed RSI on this exact padded dataset.
    expect(ind.rsi).toBeCloseTo(35.51, 1);
  });

  test("RSI(14) on strictly ascending series equals 100 (Wilder's no-loss case)", async () => {
    // For a strictly ascending series with constant +1 step, all gains, no losses.
    // Wilder's smoothed: avgLoss = 0 throughout → RSI = 100.
    const closes = Array.from({ length: 220 }, (_, i) => 100 + i);
    const candles = fromCloses(closes);
    const ind = await calc.compute(candles);
    expect(ind.rsi).toBeCloseTo(100, 5);
  });

  test("RSI(14) on alternating +1/-1 series approaches 50 (Wilder's balanced case)", async () => {
    // Alternating +1 / -1 increments → equal smoothed gains and losses → RSI ≈ 50.
    const closes = Array.from({ length: 220 }, (_, i) => 100 + (i % 2));
    const candles = fromCloses(closes);
    const ind = await calc.compute(candles);
    // Empirical value is ~51.85 (slight asymmetry from initial period boundary).
    expect(ind.rsi).toBeCloseTo(51.85, 1);
  });

  test("EMA(20) on a constant series equals the constant", async () => {
    // EMA of a constant value is that value (after warmup).
    const closes = Array(220).fill(50);
    const candles = fromCloses(closes);

    const ind = await calc.compute(candles);

    expect(ind.ema20).toBeCloseTo(50, 5);
    expect(ind.ema50).toBeCloseTo(50, 5);
    expect(ind.ema200).toBeCloseTo(50, 5);
  });

  test("EMA(20) lags moving averages on rising series", async () => {
    // Linearly rising: EMA20 should lag the linear trend.
    const closes = Array.from({ length: 220 }, (_, i) => 100 + i);
    const candles = fromCloses(closes);

    const ind = await calc.compute(candles);

    const lastClose = closes[closes.length - 1]!;

    // EMA20 should be below lastClose (lagging) but above lastClose - 20.
    expect(ind.ema20).toBeLessThan(lastClose);
    expect(ind.ema20).toBeGreaterThan(lastClose - 20);
    // Longer-period EMAs lag more than shorter-period EMAs on a rising series.
    expect(ind.ema200).toBeLessThan(ind.ema50);
    expect(ind.ema50).toBeLessThan(ind.ema20);
  });

  test("ATR(14) on constant range equals that range", async () => {
    // If high - low = 2 always, ATR should converge to 2.
    const candles: Candle[] = Array.from({ length: 220 }, (_, i) => ({
      timestamp: new Date(2026, 0, 1, 0, i),
      open: 50,
      high: 51,
      low: 49,
      close: 50,
      volume: 100,
    }));

    const ind = await calc.compute(candles);

    // High-Low = 2, no gaps so TR = 2.
    expect(ind.atr).toBeCloseTo(2, 1);
  });

  test("recentHigh and recentLow capture last 50 candles range", async () => {
    const closes: number[] = [];
    // First 200 closes: range 100-110.
    for (let i = 0; i < 200; i++) closes.push(100 + (i % 10));
    // Last 50 closes: range 200-219.
    for (let i = 0; i < 50; i++) closes.push(200 + (i % 20));

    const candles = fromCloses(closes);
    const ind = await calc.compute(candles);

    // recentHigh from highs of last 50 candles. Closes 200-219 mean
    // highs = close + 0.5 = 200.5-219.5. Max = 219.5.
    expect(ind.recentHigh).toBeCloseTo(219.5, 1);
    // recentLow from lows of last 50. Lows = close - 0.5 = 199.5-218.5. Min = 199.5.
    expect(ind.recentLow).toBeCloseTo(199.5, 1);
  });
});
