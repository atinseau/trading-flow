import { describe, expect, test } from "bun:test";
import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { CircularFallbackError, LLMRateLimitError, NoProviderAvailableError } from "@domain/errors";
import { FakeLLMProvider } from "@test-fakes/FakeLLMProvider";

const testInput = { systemPrompt: "s", userPrompt: "u", model: "x" };

describe("resolveAndCall", () => {
  test("primary available → uses primary, no fallback call", async () => {
    const p1 = new FakeLLMProvider({ name: "p1", available: true, fallback: "p2" });
    const p2 = new FakeLLMProvider({ name: "p2", available: true, fallback: null });
    const result = await resolveAndCall(
      "p1",
      testInput,
      new Map([
        ["p1", p1],
        ["p2", p2],
      ]),
    );
    expect(result.usedProvider).toBe("p1");
    expect(p2.callCount).toBe(0);
  });

  test("primary unavailable → uses fallback", async () => {
    const p1 = new FakeLLMProvider({ name: "p1", available: false, fallback: "p2" });
    const p2 = new FakeLLMProvider({ name: "p2", available: true, fallback: null });
    const result = await resolveAndCall(
      "p1",
      testInput,
      new Map([
        ["p1", p1],
        ["p2", p2],
      ]),
    );
    expect(result.usedProvider).toBe("p2");
  });

  test("primary throws rate limit → fallback used", async () => {
    const p1 = new FakeLLMProvider({
      name: "p1",
      available: true,
      fallback: "p2",
      completeImpl: async () => {
        throw new LLMRateLimitError("slow down");
      },
    });
    const p2 = new FakeLLMProvider({ name: "p2", available: true, fallback: null });
    const result = await resolveAndCall(
      "p1",
      testInput,
      new Map([
        ["p1", p1],
        ["p2", p2],
      ]),
    );
    expect(result.usedProvider).toBe("p2");
  });

  test("non-recoverable error from primary is rethrown, no fallback", async () => {
    const p1 = new FakeLLMProvider({
      name: "p1",
      available: true,
      fallback: "p2",
      completeImpl: async () => {
        throw new Error("schema validation failed");
      },
    });
    const p2 = new FakeLLMProvider({ name: "p2", available: true, fallback: null });
    await expect(
      resolveAndCall(
        "p1",
        testInput,
        new Map([
          ["p1", p1],
          ["p2", p2],
        ]),
      ),
    ).rejects.toThrow(/schema validation/);
    expect(p2.callCount).toBe(0);
  });

  test("all providers unavailable → NoProviderAvailableError", async () => {
    const p1 = new FakeLLMProvider({ name: "p1", available: false, fallback: "p2" });
    const p2 = new FakeLLMProvider({ name: "p2", available: false, fallback: null });
    await expect(
      resolveAndCall(
        "p1",
        testInput,
        new Map([
          ["p1", p1],
          ["p2", p2],
        ]),
      ),
    ).rejects.toThrow(NoProviderAvailableError);
  });

  test("circular fallback throws CircularFallbackError at runtime safety", async () => {
    const p1 = new FakeLLMProvider({ name: "p1", available: false, fallback: "p2" });
    const p2 = new FakeLLMProvider({ name: "p2", available: false, fallback: "p1" });
    await expect(
      resolveAndCall(
        "p1",
        testInput,
        new Map([
          ["p1", p1],
          ["p2", p2],
        ]),
      ),
    ).rejects.toThrow(CircularFallbackError);
  });
});
