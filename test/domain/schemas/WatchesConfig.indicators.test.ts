import { describe, expect, test } from "bun:test";
import { KNOWN_INDICATOR_IDS, WatchSchema } from "@domain/schemas/WatchesConfig";

const baseWatch = {
  id: "btc-1h",
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: [] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50, score_initial: 25, score_threshold_finalizer: 80,
    score_threshold_dead: 10, invalidation_policy: "strict", min_risk_reward_ratio: 2,
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6", max_tokens: 2000 },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5", max_tokens: 2000 },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
  },
  feedback: { enabled: false },
};

describe("WatchSchema.indicators", () => {
  test("KNOWN_INDICATOR_IDS exposes 10 plugins", () => {
    expect(KNOWN_INDICATOR_IDS.length).toBe(10);
    expect(KNOWN_INDICATOR_IDS).toContain("rsi");
    expect(KNOWN_INDICATOR_IDS).toContain("ema_stack");
    expect(KNOWN_INDICATOR_IDS).toContain("volume");
  });

  test("default indicators is empty matrix (naked)", () => {
    const parsed = WatchSchema.parse(baseWatch);
    expect(parsed.indicators).toEqual({});
  });

  test("accepts a partially populated matrix", () => {
    const parsed = WatchSchema.parse({
      ...baseWatch,
      indicators: { rsi: { enabled: true }, volume: { enabled: false } },
    });
    expect(parsed.indicators.rsi?.enabled).toBe(true);
    expect(parsed.indicators.volume?.enabled).toBe(false);
  });

  test("rejects unknown indicator id", () => {
    const result = WatchSchema.safeParse({
      ...baseWatch,
      indicators: { not_a_real_id: { enabled: true } },
    });
    expect(result.success).toBe(false);
  });

  test("indicators entry accepts a params object", () => {
    const parsed = WatchSchema.parse({
      ...baseWatch,
      indicators: { rsi: { enabled: true, params: { period: 21 } } },
    });
    expect(parsed.indicators.rsi?.params).toEqual({ period: 21 });
  });

  test("params is optional", () => {
    const parsed = WatchSchema.parse({
      ...baseWatch,
      indicators: { rsi: { enabled: true } },
    });
    expect(parsed.indicators.rsi?.params).toBeUndefined();
  });
});
