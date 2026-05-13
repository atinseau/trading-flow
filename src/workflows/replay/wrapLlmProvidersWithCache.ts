import { CachedLLMProvider } from "@adapters/llm/CachedLLMProvider";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { LLMResponseCacheStore } from "@domain/ports/LLMResponseCacheStore";

/**
 * Returns a registry mirroring the live LLM provider map, but with each
 * provider wrapped in a `CachedLLMProvider`. The wrapped provider keeps
 * the inner provider's name in its cache-key computation, so the cache
 * is sound across replay sessions even though they share the same
 * `LLMResponseCacheStore`.
 *
 * Registered under the SAME keys as the input map so `resolveAndCall`
 * navigates fallback chains unchanged: `analyzers.detector.provider`
 * still resolves to the wrapped provider for that name.
 *
 * Build one wrapped map per stage (detector / reviewer / finalizer /
 * feedback) so the right `promptVersion` is bound at construction. The
 * cache key includes `promptVersion`, so two stages share no entries.
 */
export function wrapLlmProvidersWithCache(
  providers: Map<string, LLMProvider>,
  cache: LLMResponseCacheStore,
  promptVersion: string,
): Map<string, LLMProvider> {
  const wrapped = new Map<string, LLMProvider>();
  for (const [name, provider] of providers) {
    wrapped.set(name, new CachedLLMProvider(provider, cache, promptVersion));
  }
  return wrapped;
}
