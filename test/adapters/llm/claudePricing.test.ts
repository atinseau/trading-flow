import { computeClaudeCost, lookupClaudePricing } from "@adapters/llm/claudePricing";
import { describe, expect, test } from "bun:test";

describe("claudePricing", () => {
  test("exact model match — Sonnet 4.6", () => {
    const p = lookupClaudePricing("claude-sonnet-4-6");
    expect(p).toEqual({ input: 3, output: 15, cacheCreate: 3.75, cacheRead: 0.3 });
  });

  test("dated suffix falls back to longest matching prefix", () => {
    const p = lookupClaudePricing("claude-opus-4-7-20251022");
    // claude-opus-4-7 is the longest matching key
    expect(p?.input).toBe(15);
    expect(p?.output).toBe(75);
  });

  test("family heuristic — bare 'opus' / 'sonnet' / 'haiku'", () => {
    expect(lookupClaudePricing("opus-future-2026")?.input).toBe(15);
    expect(lookupClaudePricing("sonnet-test")?.input).toBe(3);
    expect(lookupClaudePricing("haiku-experimental")?.input).toBe(1);
  });

  test("unknown model returns null", () => {
    expect(lookupClaudePricing("totally-unknown-llm")).toBeNull();
  });

  test("computes cost for a typical Sonnet call", () => {
    // 5000 input + 1500 output, no cache
    const cost = computeClaudeCost("claude-sonnet-4-6", {
      promptTokens: 5000,
      completionTokens: 1500,
    });
    // 5000 * 3 / 1M + 1500 * 15 / 1M = 0.015 + 0.0225 = 0.0375
    expect(cost).toBeCloseTo(0.0375, 6);
  });

  test("includes cache read at 0.10× input price", () => {
    // 1000 cached + 4000 uncached + 500 output, Sonnet
    const cost = computeClaudeCost("claude-sonnet-4-6", {
      promptTokens: 4000,
      completionTokens: 500,
      cacheReadTokens: 1000,
    });
    // 4000 * 3 + 500 * 15 + 1000 * 0.3 = 12000 + 7500 + 300 = 19800 → /1M
    expect(cost).toBeCloseTo(0.0198, 6);
  });

  test("includes cache creation at 1.25× input price", () => {
    const cost = computeClaudeCost("claude-haiku-4-5", {
      promptTokens: 0,
      completionTokens: 0,
      cacheCreateTokens: 10000,
    });
    // 10000 * 1.25 / 1M = 0.0125
    expect(cost).toBeCloseTo(0.0125, 6);
  });

  test("returns 0 when model is unrecognized", () => {
    const cost = computeClaudeCost("totally-unknown-llm", {
      promptTokens: 5000,
      completionTokens: 1500,
    });
    expect(cost).toBe(0);
  });
});
