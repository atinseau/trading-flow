import { describe, expect, test } from "bun:test";
import { FeedbackOutputSchema } from "@domain/schemas/FeedbackOutput";

describe("FeedbackOutputSchema", () => {
  test("parses a valid CREATE action", () => {
    const result = FeedbackOutputSchema.parse({
      summary: "Trade failed because RSI was diverging from price during the late trend phase.",
      actions: [
        {
          type: "CREATE",
          category: "reviewing",
          title: "Late-trend RSI divergence undermines continuation thesis",
          body: "When RSI fails to confirm new price highs (or lows) within three candles of a structural pivot, weight continuation lower. The pattern is most reliable when ATR is contracting at the same time, indicating waning participation.",
          rationale: "Observed sustained price-vs-RSI divergence in late phase",
        },
      ],
    });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe("CREATE");
  });

  test("parses a valid REINFORCE action", () => {
    const result = FeedbackOutputSchema.parse({
      summary: "This trade matches the existing divergence pattern lesson.",
      actions: [
        {
          type: "REINFORCE",
          lessonId: "11111111-1111-1111-1111-111111111111",
          reason: "Same RSI vs price divergence as captured by lesson",
        },
      ],
    });
    expect(result.actions[0]?.type).toBe("REINFORCE");
  });

  test("parses a valid REFINE action", () => {
    const result = FeedbackOutputSchema.parse({
      summary: "Lesson covers the case but missed the volume condition.",
      actions: [
        {
          type: "REFINE",
          lessonId: "11111111-1111-1111-1111-111111111111",
          newTitle: "Late-trend RSI divergence with low volume undermines continuation",
          newBody:
            "When RSI fails to confirm new price highs/lows within three candles of a structural pivot AND volume is below its 20-period average, weight continuation significantly lower. The combined signal is more reliable than either alone.",
          rationale: "Volume context strongly modulates the original signal",
        },
      ],
    });
    expect(result.actions[0]?.type).toBe("REFINE");
  });

  test("parses a valid DEPRECATE action", () => {
    const result = FeedbackOutputSchema.parse({
      summary: "Existing lesson contradicted under conditions that overlap its scope.",
      actions: [
        {
          type: "DEPRECATE",
          lessonId: "11111111-1111-1111-1111-111111111111",
          reason: "This trade exhibited the lesson's exact preconditions yet succeeded",
        },
      ],
    });
    expect(result.actions[0]?.type).toBe("DEPRECATE");
  });

  test("zero actions is valid", () => {
    const result = FeedbackOutputSchema.parse({
      summary: "No new insight from this trade — textbook unfortunate outcome.",
      actions: [],
    });
    expect(result.actions).toHaveLength(0);
  });

  test("rejects more than 5 actions", () => {
    const summary = "Too many actions to be useful.";
    const action = {
      type: "REINFORCE" as const,
      lessonId: "11111111-1111-1111-1111-111111111111",
      reason: "x".repeat(50),
    };
    expect(() =>
      FeedbackOutputSchema.parse({
        summary,
        actions: [action, action, action, action, action, action],
      }),
    ).toThrow();
  });

  test("rejects too-short title in CREATE", () => {
    expect(() =>
      FeedbackOutputSchema.parse({
        summary: "x".repeat(30),
        actions: [
          {
            type: "CREATE",
            category: "reviewing",
            title: "short",
            body: "y".repeat(50),
            rationale: "z".repeat(30),
          },
        ],
      }),
    ).toThrow();
  });

  test("rejects unknown category", () => {
    expect(() =>
      FeedbackOutputSchema.parse({
        summary: "x".repeat(30),
        actions: [
          {
            type: "CREATE",
            category: "tracking",
            title: "y".repeat(20),
            body: "z".repeat(60),
            rationale: "w".repeat(30),
          },
        ],
      }),
    ).toThrow();
  });
});
