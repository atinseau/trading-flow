export type LLMResponseCacheEntry = {
  inputHash: string;
  provider: string;
  model: string;
  promptVersion: string;
  responseJson: unknown;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  firstSeenAt: Date;
  lastUsedAt: Date;
  hitCount: number;
};

export type NewCacheEntry = {
  inputHash: string;
  provider: string;
  model: string;
  promptVersion: string;
  responseJson: unknown;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
};

/**
 * Mutualized response cache shared between all replay sessions. A hit
 * makes the LLM call free for subsequent identical inputs (same prompt
 * version + same rendered prompt + same image SHA → same inputHash).
 */
export interface LLMResponseCacheStore {
  get(inputHash: string): Promise<LLMResponseCacheEntry | null>;
  /**
   * Inserts a new entry. On conflict (concurrent write of same hash) the
   * existing row wins (ON CONFLICT DO NOTHING) — both callers end up
   * with a valid cached response.
   */
  set(entry: NewCacheEntry): Promise<void>;
  /** Atomically increments `hit_count` and updates `last_used_at`. */
  touchHit(inputHash: string): Promise<void>;
}
