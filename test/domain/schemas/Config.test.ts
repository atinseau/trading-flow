import { expect, test } from "bun:test";
import { ConfigSchema } from "@domain/schemas/Config";

const validMinimalConfig = {
  version: 1,
  market_data: { binance: { base_url: "https://api.binance.com" } },
  llm_providers: {
    claude_max: {
      type: "claude-agent-sdk",
      workspace_dir: "/tmp",
      fallback: null as string | null,
    },
  },
  artifacts: { type: "filesystem", base_dir: "/data" },
  notifications: { telegram: { bot_token: "x", default_chat_id: "1" } },
  database: { url: "postgres://x" },
  temporal: { address: "localhost:7233" },
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
      },
      notifications: { telegram_chat_id: "1", notify_on: ["confirmed"] },
    },
  ],
};

test("valid minimal config parses", () => {
  expect(() => ConfigSchema.parse(validMinimalConfig)).not.toThrow();
});

test("watch with provider not in llm_providers fails", () => {
  const cfg = structuredClone(validMinimalConfig);
  cfg.watches[0].analyzers.detector.provider = "ghost";
  // Zod v4 ZodError.message is JSON.stringify(issues, null, 2), so embedded "
  // characters appear as \" in the rendered string.
  expect(() => ConfigSchema.parse(cfg)).toThrow(/Provider \\"ghost\\" inconnu/);
});

test("watch with source not in market_data fails", () => {
  const cfg = structuredClone(validMinimalConfig);
  cfg.watches[0].asset.source = "ghost";
  expect(() => ConfigSchema.parse(cfg)).toThrow(/Source \\"ghost\\" inconnue/);
});

test("circular fallback chain rejected", () => {
  const cfg = structuredClone(validMinimalConfig);
  cfg.llm_providers.claude_max.fallback = "claude_max";
  expect(() => ConfigSchema.parse(cfg)).toThrow(/Cycle/);
});

test("duplicate watch ids rejected", () => {
  const cfg = structuredClone(validMinimalConfig);
  cfg.watches.push(structuredClone(cfg.watches[0]));
  expect(() => ConfigSchema.parse(cfg)).toThrow(/dupliqué/);
});

test("score thresholds in wrong order rejected", () => {
  const cfg = structuredClone(validMinimalConfig);
  cfg.watches[0].setup_lifecycle.score_threshold_finalizer = 5;
  cfg.watches[0].setup_lifecycle.score_threshold_dead = 50;
  expect(() => ConfigSchema.parse(cfg)).toThrow();
});
