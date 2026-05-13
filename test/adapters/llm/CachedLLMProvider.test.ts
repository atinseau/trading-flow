import { beforeEach, describe, expect, test } from "bun:test";
import { CachedLLMProvider, computeLLMCacheKey } from "@adapters/llm/CachedLLMProvider";
import type { LLMInput, LLMOutput, LLMProvider } from "@domain/ports/LLMProvider";
import { InMemoryLLMResponseCacheStore } from "../../fakes/InMemoryLLMResponseCacheStore";

class CountingProvider implements LLMProvider {
  readonly name = "fake";
  readonly fallback: string | null = null;
  callCount = 0;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async complete(_input: LLMInput): Promise<LLMOutput> {
    this.callCount += 1;
    return {
      content: `response-${this.callCount}`,
      parsed: { verdict: "NEUTRAL", scoreDelta: 0 },
      costUsd: 0.012,
      latencyMs: 4200,
      promptTokens: 1000,
      completionTokens: 200,
    };
  }
}

function mkInput(overrides: Partial<LLMInput> = {}): LLMInput {
  return {
    systemPrompt: "You are the Detector.",
    userPrompt: "Tick at 2026-04-12T14:00:00Z.",
    images: [{ sourceUri: "file:///tmp/chart-sha-abc.png", mimeType: "image/png" }],
    model: "claude-sonnet-4-6",
    maxTokens: 1024,
    temperature: 0,
    ...overrides,
  };
}

let cache: InMemoryLLMResponseCacheStore;
let inner: CountingProvider;
let provider: CachedLLMProvider;

beforeEach(() => {
  cache = new InMemoryLLMResponseCacheStore();
  inner = new CountingProvider();
  provider = new CachedLLMProvider(inner, cache, "detector_v3");
});

describe("computeLLMCacheKey", () => {
  test("stable across calls with same input", () => {
    const a = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v3",
      input: mkInput(),
    });
    const b = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v3",
      input: mkInput(),
    });
    expect(a).toBe(b);
  });

  test("changes if the user prompt changes", () => {
    const a = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v3",
      input: mkInput({ userPrompt: "x" }),
    });
    const b = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v3",
      input: mkInput({ userPrompt: "y" }),
    });
    expect(a).not.toBe(b);
  });

  test("changes if the prompt version changes (schema change proxy)", () => {
    const a = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v3",
      input: mkInput(),
    });
    const b = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v4",
      input: mkInput(),
    });
    expect(a).not.toBe(b);
  });

  test("changes if image URI changes (content-addressable in prod)", () => {
    const a = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v3",
      input: mkInput({ images: [{ sourceUri: "file:///a.png", mimeType: "image/png" }] }),
    });
    const b = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v3",
      input: mkInput({ images: [{ sourceUri: "file:///b.png", mimeType: "image/png" }] }),
    });
    expect(a).not.toBe(b);
  });

  test("changes if model changes", () => {
    const a = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v3",
      input: mkInput({ model: "claude-sonnet-4-6" }),
    });
    const b = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v3",
      input: mkInput({ model: "claude-haiku-4-5" }),
    });
    expect(a).not.toBe(b);
  });
});

describe("CachedLLMProvider.complete", () => {
  test("first call → miss, calls inner, stores cache entry, costUsd preserved", async () => {
    const out = await provider.complete(mkInput());
    expect(inner.callCount).toBe(1);
    expect(out.costUsd).toBeCloseTo(0.012, 5);
    expect(out.content).toBe("response-1");
  });

  test("second call with same input → hit, inner NOT called, costUsd=0", async () => {
    const first = await provider.complete(mkInput());
    expect(inner.callCount).toBe(1);
    const second = await provider.complete(mkInput());
    expect(inner.callCount).toBe(1); // unchanged
    expect(second.costUsd).toBe(0);
    expect(second.content).toBe(first.content);
    expect(second.promptTokens).toBe(first.promptTokens);
    expect(second.completionTokens).toBe(first.completionTokens);
  });

  test("hit increments cache hit_count + lastUsedAt", async () => {
    await provider.complete(mkInput());
    const key = computeLLMCacheKey({
      providerName: "fake",
      promptVersion: "detector_v3",
      input: mkInput(),
    });
    const before = await cache.get(key);
    const t0 = before?.lastUsedAt.getTime() ?? 0;
    await new Promise((r) => setTimeout(r, 10));
    await provider.complete(mkInput());
    const after = await cache.get(key);
    expect(after?.hitCount).toBe(1);
    expect((after?.lastUsedAt.getTime() ?? 0) >= t0).toBe(true);
  });

  test("different prompts → independent cache entries", async () => {
    await provider.complete(mkInput({ userPrompt: "x" }));
    await provider.complete(mkInput({ userPrompt: "y" }));
    expect(inner.callCount).toBe(2);
  });

  test("name exposes wrapped provider", () => {
    expect(provider.name).toBe("cached(fake)");
  });
});
