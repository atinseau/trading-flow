import { describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { evaluatePreFilter } from "@workflows/scheduler/preFilter";

const registry = new IndicatorRegistry();
const allPlugins = registry.all();
const baseConfig = {
  enabled: true,
  mode: "lenient" as const,
  thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 },
};

describe("preFilter β degradation", () => {
  test("all criteria active + lenient: passes if any criterion hits", () => {
    const scalars = {
      atr: 100,
      atrMa20: 50,
      lastVolume: 100,
      volumeMa20: 100,
      rsi: 50,
      recentHigh: 200,
      recentLow: 100,
    };
    const candles = [
      { timestamp: new Date(), open: 100, high: 100, low: 100, close: 150, volume: 10 },
    ];
    const result = evaluatePreFilter(candles, scalars, baseConfig, [...allPlugins]);
    expect(result.passed).toBe(true);
  });

  test("no plugins active: returns passed=true (zero evaluated)", () => {
    const result = evaluatePreFilter([], {}, baseConfig, []);
    expect(result.passed).toBe(true);
    expect(result.reasons).toContain("no_active_criteria");
  });

  test("only RSI active: only rsi_extreme_distance evaluated", () => {
    const rsiOnly = [...allPlugins].filter((p) => p.id === "rsi");
    const scalars = { rsi: 80 };
    const result = evaluatePreFilter([], scalars, baseConfig, rsiOnly);
    expect(result.passed).toBe(true);
    expect(result.reasons[0]).toContain("rsi_extreme");
  });

  test("disabled config: passes regardless", () => {
    const result = evaluatePreFilter([], {}, { ...baseConfig, enabled: false }, [...allPlugins]);
    expect(result.passed).toBe(true);
  });

  test("calm market with all plugins: does not pass (no criterion triggered)", () => {
    const scalars = {
      atr: 1,
      atrMa20: 1,
      lastVolume: 100,
      volumeMa20: 100,
      rsi: 50,
      recentHigh: 110,
      recentLow: 90,
    };
    const result = evaluatePreFilter([], scalars, baseConfig, [...allPlugins]);
    expect(result.passed).toBe(false);
  });

  test("volume spike triggers pass", () => {
    const scalars = {
      atr: 1,
      atrMa20: 1,
      lastVolume: 200,
      volumeMa20: 100,
      rsi: 50,
      recentHigh: 110,
      recentLow: 90,
    };
    const result = evaluatePreFilter([], scalars, baseConfig, [...allPlugins]);
    expect(result.passed).toBe(true);
  });
});
