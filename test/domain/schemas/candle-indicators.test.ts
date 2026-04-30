import { expect, test } from "bun:test";
import { LegacyIndicatorsSchema as IndicatorsSchema } from "@adapters/indicators/PureJsIndicatorCalculator";
import { CandleSchema } from "@domain/schemas/Candle";

test("CandleSchema parses valid OHLCV", () => {
  const raw = {
    timestamp: new Date("2026-04-28T14:00:00Z"),
    open: 67800.5,
    high: 68120.0,
    low: 67710.2,
    close: 68042.8,
    volume: 1247.3,
  };
  const parsed = CandleSchema.parse(raw);
  expect(parsed.close).toBe(68042.8);
});

test("CandleSchema rejects negative volume", () => {
  expect(() =>
    CandleSchema.parse({
      timestamp: new Date(),
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: -1,
    }),
  ).toThrow();
});

test("IndicatorsSchema parses valid set", () => {
  const ind = IndicatorsSchema.parse({
    rsi: 58.4,
    ema20: 67234.5,
    ema50: 66980.1,
    ema200: 65000,
    atr: 412.7,
    atrMa20: 380.2,
    volumeMa20: 689.4,
    lastVolume: 1247.3,
    recentHigh: 68500,
    recentLow: 41800,
  });
  expect(ind.rsi).toBe(58.4);
});

test("IndicatorsSchema rejects rsi outside 0-100", () => {
  expect(() =>
    IndicatorsSchema.parse({
      rsi: 150,
      ema20: 1,
      ema50: 1,
      ema200: 1,
      atr: 1,
      atrMa20: 1,
      volumeMa20: 1,
      lastVolume: 1,
      recentHigh: 1,
      recentLow: 1,
    }),
  ).toThrow();
});
