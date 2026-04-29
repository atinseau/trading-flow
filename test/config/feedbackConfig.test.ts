import { describe, expect, test } from "bun:test";
import { FeedbackConfigSchema } from "@domain/schemas/WatchesConfig";

describe("FeedbackConfigSchema", () => {
  test("default values when block is omitted", () => {
    const parsed = FeedbackConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.maxActiveLessonsPerCategory).toBe(30);
    expect(parsed.injection).toEqual({ detector: true, reviewer: true, finalizer: true });
    expect(parsed.contextProvidersDisabled).toEqual([]);
  });

  test("known provider IDs are accepted", () => {
    const parsed = FeedbackConfigSchema.parse({
      contextProvidersDisabled: ["chart-post-mortem"],
    });
    expect(parsed.contextProvidersDisabled).toEqual(["chart-post-mortem"]);
  });

  test("unknown provider ID is rejected", () => {
    expect(() =>
      FeedbackConfigSchema.parse({
        contextProvidersDisabled: ["nonsense-provider"],
      }),
    ).toThrow();
  });

  test("maxActiveLessonsPerCategory bounds", () => {
    expect(() => FeedbackConfigSchema.parse({ maxActiveLessonsPerCategory: 0 })).toThrow();
    expect(() => FeedbackConfigSchema.parse({ maxActiveLessonsPerCategory: 201 })).toThrow();
    const ok = FeedbackConfigSchema.parse({ maxActiveLessonsPerCategory: 50 });
    expect(ok.maxActiveLessonsPerCategory).toBe(50);
  });

  test("analyzer is optional", () => {
    const parsed = FeedbackConfigSchema.parse({
      analyzer: { provider: "claude_max", model: "claude-opus-4-7" },
    });
    expect(parsed.analyzer?.model).toBe("claude-opus-4-7");
  });
});
