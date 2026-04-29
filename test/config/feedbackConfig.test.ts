import { describe, expect, test } from "bun:test";
import { FeedbackConfigSchema, WatchSchema } from "@domain/schemas/WatchesConfig";

describe("FeedbackConfigSchema", () => {
  test("default values when block is omitted", () => {
    const parsed = FeedbackConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.max_active_lessons_per_category).toBe(30);
    expect(parsed.injection).toEqual({ detector: true, reviewer: true, finalizer: true });
    expect(parsed.context_providers_disabled).toEqual([]);
  });

  test("known provider IDs are accepted", () => {
    const parsed = FeedbackConfigSchema.parse({
      context_providers_disabled: ["chart-post-mortem"],
    });
    expect(parsed.context_providers_disabled).toEqual(["chart-post-mortem"]);
  });

  test("unknown provider ID is rejected", () => {
    expect(() =>
      FeedbackConfigSchema.parse({
        context_providers_disabled: ["nonsense-provider"],
      }),
    ).toThrow();
  });

  test("max_active_lessons_per_category bounds", () => {
    expect(() => FeedbackConfigSchema.parse({ max_active_lessons_per_category: 0 })).toThrow();
    expect(() => FeedbackConfigSchema.parse({ max_active_lessons_per_category: 201 })).toThrow();
    const ok = FeedbackConfigSchema.parse({ max_active_lessons_per_category: 50 });
    expect(ok.max_active_lessons_per_category).toBe(50);
  });

  test("max_active_lessons_per_category accepts a non-default value", () => {
    const parsed = FeedbackConfigSchema.parse({ max_active_lessons_per_category: 50 });
    expect(parsed.max_active_lessons_per_category).toBe(50);
  });

  test("context_providers_disabled accepts a non-default list", () => {
    const parsed = FeedbackConfigSchema.parse({
      context_providers_disabled: ["chart-post-mortem", "post-mortem-ohlcv"],
    });
    expect(parsed.context_providers_disabled).toEqual([
      "chart-post-mortem",
      "post-mortem-ohlcv",
    ]);
  });

  test("analyzer is optional", () => {
    const parsed = FeedbackConfigSchema.parse({
      analyzer: { provider: "claude_max", model: "claude-opus-4-7" },
    });
    expect(parsed.analyzer?.model).toBe("claude-opus-4-7");
  });
});

// Helper to build a minimal watch input that satisfies WatchSchema.
function makeWatchInput(overrides: {
  feedback?: Record<string, unknown>;
  analyzersFeedback?: { provider: string; model: string };
}) {
  const analyzers: Record<string, unknown> = {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6", max_tokens: 2000 },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5", max_tokens: 2000 },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
  };
  if (overrides.analyzersFeedback) {
    analyzers.feedback = overrides.analyzersFeedback;
  }
  const base: Record<string, unknown> = {
    id: "btc-1h",
    asset: { symbol: "BTCUSDT", source: "binance" },
    timeframes: { primary: "1h", higher: [] },
    schedule: { timezone: "UTC" },
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
    setup_lifecycle: {
      ttl_candles: 50,
      score_initial: 25,
      score_threshold_finalizer: 80,
      score_threshold_dead: 10,
      invalidation_policy: "strict",
    },
    analyzers,
    notify_on: [],
  };
  if (overrides.feedback !== undefined) {
    base.feedback = overrides.feedback;
  }
  return base;
}

describe("WatchSchema feedback cross-validation (superRefine)", () => {
  test("enabled: true + no analyzer + no analyzers.feedback → fails", () => {
    const input = makeWatchInput({ feedback: { enabled: true } });
    const result = WatchSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "feedback.analyzer");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("feedback.enabled: true");
      expect(issue?.message).toContain("no LLM analyzer configured");
    }
  });

  test("enabled: false + no analyzer → succeeds", () => {
    const input = makeWatchInput({ feedback: { enabled: false } });
    const result = WatchSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("enabled: true + feedback.analyzer set → succeeds", () => {
    const input = makeWatchInput({
      feedback: { enabled: true, analyzer: { provider: "claude_max", model: "claude-opus-4-7" } },
    });
    const result = WatchSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("enabled: true + analyzers.feedback set → succeeds", () => {
    const input = makeWatchInput({
      feedback: { enabled: true },
      analyzersFeedback: { provider: "claude_max", model: "claude-opus-4-7" },
    });
    const result = WatchSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});
