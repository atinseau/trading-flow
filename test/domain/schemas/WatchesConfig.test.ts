import { describe, expect, test } from "bun:test";
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
  expect(r.error.issues.some((i) => i.path.join(".") === "analyzers.detector.provider")).toBe(true);
});

const minimalYahooWatch = {
  ...minimalValidWatch,
  asset: { symbol: "AAPL", source: "yahoo", quoteType: "EQUITY", exchange: "NMS" },
};

describe("WatchSchema asset invariants", () => {
  test("yahoo EQUITY without exchange → invalid", () => {
    const w = structuredClone(minimalYahooWatch);
    // biome-ignore lint/suspicious/noExplicitAny: testing schema invariant
    (w as any).asset = { symbol: "AAPL", source: "yahoo", quoteType: "EQUITY" };
    const r = WatchSchema.safeParse(w);
    expect(r.success).toBe(false);
  });

  test("yahoo EQUITY with exchange → valid", () => {
    const r = WatchSchema.safeParse(minimalYahooWatch);
    expect(r.success).toBe(true);
  });

  test("yahoo ETF without exchange → invalid", () => {
    const w = structuredClone(minimalYahooWatch);
    // biome-ignore lint/suspicious/noExplicitAny: testing schema invariant
    (w as any).asset = { symbol: "QQQ", source: "yahoo", quoteType: "ETF" };
    const r = WatchSchema.safeParse(w);
    expect(r.success).toBe(false);
  });

  test("yahoo INDEX without exchange → invalid", () => {
    const w = structuredClone(minimalYahooWatch);
    // biome-ignore lint/suspicious/noExplicitAny: testing schema invariant
    (w as any).asset = { symbol: "^GSPC", source: "yahoo", quoteType: "INDEX" };
    const r = WatchSchema.safeParse(w);
    expect(r.success).toBe(false);
  });

  test("yahoo CURRENCY without exchange → valid (forex global)", () => {
    const w = structuredClone(minimalYahooWatch);
    // biome-ignore lint/suspicious/noExplicitAny: testing schema invariant
    (w as any).asset = { symbol: "EURUSD=X", source: "yahoo", quoteType: "CURRENCY" };
    const r = WatchSchema.safeParse(w);
    expect(r.success).toBe(true);
  });

  test("yahoo FUTURE without exchange → valid", () => {
    const w = structuredClone(minimalYahooWatch);
    // biome-ignore lint/suspicious/noExplicitAny: testing schema invariant
    (w as any).asset = { symbol: "ES=F", source: "yahoo", quoteType: "FUTURE" };
    const r = WatchSchema.safeParse(w);
    expect(r.success).toBe(true);
  });

  test("yahoo without quoteType → invalid (forces recreation)", () => {
    const w = structuredClone(minimalYahooWatch);
    // biome-ignore lint/suspicious/noExplicitAny: testing schema invariant
    (w as any).asset = { symbol: "AAPL", source: "yahoo" };
    const r = WatchSchema.safeParse(w);
    expect(r.success).toBe(false);
  });

  test("binance without quoteType/exchange → valid (still works)", () => {
    const r = WatchSchema.safeParse(minimalValidWatch);
    expect(r.success).toBe(true);
  });
});
