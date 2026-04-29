import { expect, test } from "bun:test";
import { WatchSchema } from "@domain/schemas/WatchesConfig";

const minimalValidWatch = {
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
  feedback: {},
};

test("WatchSchema accepts minimal valid input", () => {
  const r = WatchSchema.safeParse(minimalValidWatch);
  expect(r.success).toBe(true);
});

test("WatchSchema defaults include_chart_image and include_reasoning to true", () => {
  const r = WatchSchema.safeParse(minimalValidWatch);
  if (!r.success) throw new Error("expected success");
  expect(r.data.include_chart_image).toBe(true);
  expect(r.data.include_reasoning).toBe(true);
});

test("WatchSchema accepts explicit include_chart_image = false", () => {
  const w = structuredClone(minimalValidWatch);
  // biome-ignore lint/suspicious/noExplicitAny: probing schema with extra keys
  (w as any).include_chart_image = false;
  const r = WatchSchema.safeParse(w);
  if (!r.success) throw new Error("expected success");
  expect(r.data.include_chart_image).toBe(false);
});

test("WatchSchema rejects unknown asset.source", () => {
  const w = structuredClone(minimalValidWatch);
  w.asset.source = "kraken";
  const r = WatchSchema.safeParse(w);
  expect(r.success).toBe(false);
  if (r.success) return;
  expect(r.error.issues.some((i) => i.path.join(".") === "asset.source")).toBe(true);
});

test("WatchSchema rejects unknown analyzer provider", () => {
  const w = structuredClone(minimalValidWatch);
  w.analyzers.detector.provider = "openai";
  const r = WatchSchema.safeParse(w);
  expect(r.success).toBe(false);
  if (r.success) return;
  expect(r.error.issues.some((i) => i.path.join(".") === "analyzers.detector.provider")).toBe(
    true,
  );
});
