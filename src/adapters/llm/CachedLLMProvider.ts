import { createHash } from "node:crypto";
import type { LLMInput, LLMOutput, LLMProvider } from "@domain/ports/LLMProvider";
import type { LLMResponseCacheStore } from "@domain/ports/LLMResponseCacheStore";

/**
 * Computes a stable cache key for an LLM call. Includes the provider
 * name, model, full prompts, image URIs (production URIs contain a
 * content sha256, making them content-addressable), and deterministic
 * generation parameters.
 *
 * The response schema is NOT part of the hash: when a schema changes
 * the prompt version is bumped, which changes the systemPrompt/userPrompt
 * content — so the hash invalidates implicitly. Documented as a
 * convention rather than an enforced invariant.
 *
 * Exported for the workflow / activity layer to log the same key it
 * sees in audit tables.
 */
export function computeLLMCacheKey(args: {
  providerName: string;
  promptVersion: string;
  input: LLMInput;
}): string {
  const imgs = (args.input.images ?? []).map((i) => `${i.mimeType}:${i.sourceUri}`).sort();
  const payload = {
    provider: args.providerName,
    promptVersion: args.promptVersion,
    model: args.input.model,
    systemPrompt: args.input.systemPrompt,
    userPrompt: args.input.userPrompt,
    images: imgs,
    maxTokens: args.input.maxTokens ?? null,
    temperature: args.input.temperature ?? null,
  };
  const canonical = JSON.stringify(payload);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Wraps any LLMProvider with a mutualized response cache (the
 * `LLMResponseCacheStore` port, backed by the `llm_response_cache` table
 * in production). On hit, returns the cached output with `costUsd=0` and
 * very low latency; the original full cost remains attributed to whoever
 * first paid for it.
 *
 * The cache key is computed via `computeLLMCacheKey` and includes the
 * provider, model, both prompts, and image URIs.  Different prompt
 * versions yield distinct keys, so a prompt edit naturally invalidates
 * the cache.
 *
 * Concurrent writes of the same key are safe: `cache.set` uses
 * ON CONFLICT DO NOTHING under the hood.
 */
export class CachedLLMProvider implements LLMProvider {
  readonly name: string;
  readonly fallback: string | null;

  constructor(
    private readonly inner: LLMProvider,
    private readonly cache: LLMResponseCacheStore,
    private readonly promptVersion: string,
  ) {
    this.name = `cached(${inner.name})`;
    this.fallback = inner.fallback;
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  async complete(input: LLMInput): Promise<LLMOutput> {
    const key = computeLLMCacheKey({
      providerName: this.inner.name,
      promptVersion: this.promptVersion,
      input,
    });

    const hit = await this.cache.get(key);
    if (hit) {
      await this.cache.touchHit(key);
      const cached = hit.responseJson as { content?: unknown; parsed?: unknown } | null;
      return {
        content: typeof cached?.content === "string" ? cached.content : "",
        parsed: cached?.parsed,
        costUsd: 0,
        latencyMs: 0,
        promptTokens: hit.promptTokens,
        completionTokens: hit.completionTokens,
      };
    }

    const output = await this.inner.complete(input);
    await this.cache.set({
      inputHash: key,
      provider: this.inner.name,
      model: input.model,
      promptVersion: this.promptVersion,
      responseJson: { content: output.content, parsed: output.parsed },
      promptTokens: output.promptTokens,
      completionTokens: output.completionTokens,
      costUsd: output.costUsd,
    });
    return output;
  }
}
