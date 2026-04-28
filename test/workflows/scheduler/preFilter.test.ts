import { expect, test } from "bun:test";
import { evaluatePreFilter } from "@workflows/scheduler/preFilter";

const baseConfig = {
  enabled: true,
  mode: "lenient" as const,
  thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 },
};
const baseInd = {
  rsi: 50,
  ema20: 100,
  ema50: 100,
  ema200: 100,
  atr: 1,
  atrMa20: 1,
  volumeMa20: 100,
  lastVolume: 100,
  recentHigh: 110,
  recentLow: 90,
};

test("disabled pre_filter always passes", () => {
  expect(evaluatePreFilter([], baseInd, { ...baseConfig, enabled: false }).passed).toBe(true);
});

test("calm market does not pass", () => {
  expect(evaluatePreFilter([], baseInd, baseConfig).passed).toBe(false);
});

test("volume spike triggers pass", () => {
  const ind = { ...baseInd, lastVolume: 200, volumeMa20: 100 };
  expect(evaluatePreFilter([], ind, baseConfig).passed).toBe(true);
});

test("RSI extreme triggers pass", () => {
  const ind = { ...baseInd, rsi: 80 };
  expect(evaluatePreFilter([], ind, baseConfig).passed).toBe(true);
});
