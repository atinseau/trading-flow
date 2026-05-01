import { expect, test } from "bun:test";
import { CandleSchema } from "@domain/schemas/Candle";
import { IndicatorsSchema } from "@domain/schemas/Indicators";
import { NEUTRAL_INDICATORS } from "../../fakes/FakeIndicatorCalculator";

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
    ...NEUTRAL_INDICATORS,
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
  expect(() => IndicatorsSchema.parse({ ...NEUTRAL_INDICATORS, rsi: 150 })).toThrow();
});
