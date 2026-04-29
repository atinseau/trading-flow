import { expect, test } from "bun:test";
import { WatchesConfigSchema } from "@domain/schemas/WatchesConfig";

const minimalValid = {
  version: 1,
  market_data: ["binance"],
  llm_providers: {
    claude_max: { type: "claude-agent-sdk", fallback: null },
  },
  artifacts: { type: "filesystem" },
  watches: [
    {
      id: "btc-1h",
      asset: { symbol: "BTCUSDT", source: "binance" },
      timeframes: { primary: "1h", higher: [] },
      schedule: { detector_cron: "*/15 * * * *" },
      candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
      setup_lifecycle: {
        ttl_candles: 50,
        score_initial: 25,
        score_threshold_finalizer: 80,
        score_threshold_dead: 10,
        invalidation_policy: "strict",
      },
      analyzers: {
        detector: { provider: "claude_max", model: "x" },
        reviewer: { provider: "claude_max", model: "x" },
        finalizer: { provider: "claude_max", model: "x" },
        feedback: { provider: "claude_max", model: "x" },
      },
      notify_on: ["confirmed"],
    },
  ],
};

test("WatchesConfigSchema accepts minimal valid input", () => {
  const r = WatchesConfigSchema.safeParse(minimalValid);
  expect(r.success).toBe(true);
});

test("WatchesConfigSchema parses market_data as a string array", () => {
  const r = WatchesConfigSchema.safeParse(minimalValid);
  if (!r.success) throw new Error("expected success");
  expect(r.data.market_data).toEqual(["binance"]);
});

test("WatchesConfigSchema rejects watch.asset.source not in market_data", () => {
  const bad = structuredClone(minimalValid);
  bad.watches[0].asset.source = "kraken";
  const r = WatchesConfigSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test("WatchesConfigSchema defaults notifications.telegram to false when block absent", () => {
  const r = WatchesConfigSchema.safeParse(minimalValid);
  if (!r.success) throw new Error("expected success");
  expect(r.data.notifications.telegram).toBe(false);
});

test("WatchesConfigSchema accepts notifications.telegram = true", () => {
  const withTelegram = { ...minimalValid, notifications: { telegram: true } };
  const r = WatchesConfigSchema.safeParse(withTelegram);
  if (!r.success) throw new Error("expected success");
  expect(r.data.notifications.telegram).toBe(true);
});

test("WatchesConfigSchema rejects unknown llm provider in watch.analyzers", () => {
  const bad = structuredClone(minimalValid);
  bad.watches[0].analyzers.detector.provider = "openai";
  const r = WatchesConfigSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test("WatchesConfigSchema rejects duplicate watch IDs", () => {
  const bad = structuredClone(minimalValid);
  bad.watches.push(structuredClone(bad.watches[0]));
  const r = WatchesConfigSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test("WatchSchema defaults include_chart_image and include_reasoning to true", () => {
  const r = WatchesConfigSchema.safeParse(minimalValid);
  if (!r.success) throw new Error("expected success");
  expect(r.data.watches[0].include_chart_image).toBe(true);
  expect(r.data.watches[0].include_reasoning).toBe(true);
});

test("WatchSchema accepts explicit include_chart_image = false", () => {
  const w = structuredClone(minimalValid);
  // biome-ignore lint/suspicious/noExplicitAny: probing schema with extra keys
  (w.watches[0] as any).include_chart_image = false;
  const r = WatchesConfigSchema.safeParse(w);
  if (!r.success) throw new Error("expected success");
  expect(r.data.watches[0].include_chart_image).toBe(false);
});
