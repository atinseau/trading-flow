import { describe, expect, test } from "bun:test";
import { FeedbackConfigSchema } from "@domain/schemas/WatchesConfig";

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
