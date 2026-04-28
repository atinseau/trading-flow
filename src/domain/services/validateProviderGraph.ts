import { CircularFallbackError, InvalidConfigError } from "@domain/errors";

export type ProviderGraphNode = { fallback: string | null };

export function validateProviderGraph(providers: Record<string, ProviderGraphNode>): void {
  for (const startName of Object.keys(providers)) {
    const visited = new Set<string>();
    let current: string | null = startName;
    while (current !== null) {
      if (visited.has(current)) {
        const path = [...visited, current].join(" → ");
        throw new CircularFallbackError(`Cycle detected: ${path}`);
      }
      visited.add(current);
      const node = providers[current];
      if (!node) {
        throw new InvalidConfigError(`Fallback to unknown provider: ${current}`);
      }
      current = node.fallback;
    }
  }
}
