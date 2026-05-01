import { describe, expect, test } from "bun:test";
import type { HtfContext } from "@domain/services/htfContext";
import { classifyRegime } from "@domain/services/marketRegime";
import { NEUTRAL_INDICATORS } from "../../fakes/FakeIndicatorCalculator";

const HTF_FLAT: HtfContext = {
  daily5: [],
  weeklyHigh: 100,
  weeklyLow: 100,
  monthlyHigh: 100,
  monthlyLow: 100,
  positionInWeeklyRange: 0.5,
  dailyTrend: "sideways",
};

describe("classifyRegime", () => {
  test("HTF uptrend dominates over local EMAs", () => {
    const reg = classifyRegime(
      { ...NEUTRAL_INDICATORS, ema20: 90, ema50: 95, ema200: 100 }, // local bearish stack
      { ...HTF_FLAT, dailyTrend: "uptrend" },
    );
    expect(reg.label).toBe("uptrend");
  });

  test("Local EMAs used when HTF is sideways", () => {
    const reg = classifyRegime(
      { ...NEUTRAL_INDICATORS, ema20: 110, ema50: 100, ema200: 90 }, // bullish stack
      HTF_FLAT,
    );
    expect(reg.label).toBe("uptrend");
  });

  test("Squeeze flag fires on tight BB bandwidth", () => {
    const reg = classifyRegime({ ...NEUTRAL_INDICATORS, bbBandwidthPct: 2.5 }, HTF_FLAT);
    expect(reg.squeeze).toBe(true);
  });

  test("Squeeze flag fires on negative ATR z-score", () => {
    const reg = classifyRegime(
      { ...NEUTRAL_INDICATORS, atrZScore200: -1.5, bbBandwidthPct: 8 },
      HTF_FLAT,
    );
    expect(reg.squeeze).toBe(true);
  });

  test("Volatility expansion fires above z-score 1.5", () => {
    const reg = classifyRegime({ ...NEUTRAL_INDICATORS, atrZScore200: 2 }, HTF_FLAT);
    expect(reg.volatilityExpansion).toBe(true);
  });

  test("Ranging when no signal converges", () => {
    const reg = classifyRegime(
      { ...NEUTRAL_INDICATORS, ema20: 100, ema50: 100, ema200: 100 },
      HTF_FLAT,
    );
    expect(reg.label).toBe("ranging");
  });
});
