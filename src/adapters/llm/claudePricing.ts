/**
 * Anthropic Claude pricing — per 1 million tokens, USD.
 *
 * Source: docs.anthropic.com/en/docs/about-claude/pricing
 * Update when Anthropic adjusts published rates. Numbers are approximate
 * "list" prices; actual billing on the Pay-as-you-go API matches these.
 *
 * The Claude Agent SDK / Claude Max plan does NOT bill per-call — you pay
 * a flat monthly fee. We compute cost as if the call had hit the API to
 * give the operator a sense of "marginal usage value": "if I weren't on
 * Max, this would have cost me $X this month".
 *
 * Caching breakdown:
 * - input  = uncached prompt tokens (full price)
 * - cacheCreate  = prompt tokens written to cache (1.25× input price for 5min,
 *                  2× input price for 1h cache — we use the 5min default)
 * - cacheRead    = prompt tokens served from cache (0.10× input price)
 * - output = completion tokens
 */

type ModelPricing = {
  /** Per 1M tokens, USD */
  input: number;
  output: number;
  cacheCreate: number; // 1.25× input typically
  cacheRead: number; // 0.10× input typically
};

const PRICING: Record<string, ModelPricing> = {
  // Claude 4.x family (current)
  "claude-opus-4-7": { input: 15.0, output: 75.0, cacheCreate: 18.75, cacheRead: 1.5 },
  "claude-opus-4-6": { input: 15.0, output: 75.0, cacheCreate: 18.75, cacheRead: 1.5 },
  "claude-opus-4-1": { input: 15.0, output: 75.0, cacheCreate: 18.75, cacheRead: 1.5 },
  "claude-opus-4": { input: 15.0, output: 75.0, cacheCreate: 18.75, cacheRead: 1.5 },

  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheCreate: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheCreate: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3.0, output: 15.0, cacheCreate: 3.75, cacheRead: 0.3 },

  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheCreate: 1.25, cacheRead: 0.1 },
  "claude-haiku-4": { input: 1.0, output: 5.0, cacheCreate: 1.25, cacheRead: 0.1 },

  // Claude 3.5 family (legacy fallback)
  "claude-3-5-sonnet": { input: 3.0, output: 15.0, cacheCreate: 3.75, cacheRead: 0.3 },
  "claude-3-5-haiku": { input: 0.8, output: 4.0, cacheCreate: 1.0, cacheRead: 0.08 },
  "claude-3-opus": { input: 15.0, output: 75.0, cacheCreate: 18.75, cacheRead: 1.5 },
};

/**
 * Best-effort match. The Claude SDK accepts model IDs like
 * "claude-sonnet-4-6", "claude-opus-4-7-20251022", etc. We:
 *   1. Try exact match
 *   2. Fall back to the longest known prefix (handles dated suffixes)
 *   3. Fall back to family heuristic (opus / sonnet / haiku)
 *
 * Returns null when no estimate is possible (rare — would need a brand new
 * model ID that doesn't even contain a known family substring).
 */
export function lookupClaudePricing(model: string): ModelPricing | null {
  if (PRICING[model]) return PRICING[model];

  const candidates = Object.keys(PRICING).sort((a, b) => b.length - a.length);
  for (const key of candidates) {
    if (model.startsWith(key)) return PRICING[key]!;
  }

  if (model.includes("opus")) return PRICING["claude-opus-4-7"]!;
  if (model.includes("sonnet")) return PRICING["claude-sonnet-4-6"]!;
  if (model.includes("haiku")) return PRICING["claude-haiku-4-5"]!;

  return null;
}

export type ClaudeUsage = {
  promptTokens: number;
  completionTokens: number;
  cacheCreateTokens?: number;
  cacheReadTokens?: number;
};

/**
 * Compute estimated USD cost for a single Claude call.
 * `promptTokens` here is the UNCACHED portion (matches Anthropic's
 * `input_tokens` field — does NOT include cache_creation or cache_read,
 * which are billed separately).
 */
export function computeClaudeCost(model: string, usage: ClaudeUsage): number {
  const p = lookupClaudePricing(model);
  if (!p) return 0;
  return (
    (usage.promptTokens * p.input +
      usage.completionTokens * p.output +
      (usage.cacheCreateTokens ?? 0) * p.cacheCreate +
      (usage.cacheReadTokens ?? 0) * p.cacheRead) /
    1_000_000
  );
}
