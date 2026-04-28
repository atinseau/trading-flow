import {
  CircularFallbackError,
  ExchangeRateLimitError,
  FetchTimeoutError,
  LLMRateLimitError,
  LLMTimeoutError,
  NoProviderAvailableError,
} from "@domain/errors";
import type { LLMInput, LLMOutput, LLMProvider } from "@domain/ports/LLMProvider";

export type ResolveResult = {
  output: LLMOutput;
  usedProvider: string;
};

function isRecoverableForFallback(err: unknown): boolean {
  return (
    err instanceof LLMRateLimitError ||
    err instanceof LLMTimeoutError ||
    err instanceof FetchTimeoutError ||
    err instanceof ExchangeRateLimitError
  );
}

export async function resolveAndCall(
  startName: string,
  input: LLMInput,
  registry: Map<string, LLMProvider>,
): Promise<ResolveResult> {
  const visited = new Set<string>();
  let currentName: string | null = startName;

  while (currentName !== null) {
    if (visited.has(currentName)) {
      throw new CircularFallbackError(`Cycle detected: ${[...visited, currentName].join(" → ")}`);
    }
    visited.add(currentName);

    const provider = registry.get(currentName);
    if (!provider) throw new Error(`Provider "${currentName}" not in registry`);

    if (await provider.isAvailable()) {
      try {
        const output = await provider.complete(input);
        return { output, usedProvider: currentName };
      } catch (err) {
        if (!isRecoverableForFallback(err)) throw err;
      }
    }

    currentName = provider.fallback;
  }

  throw new NoProviderAvailableError(`No available provider in chain starting from ${startName}`);
}
