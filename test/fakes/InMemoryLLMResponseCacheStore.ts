import type {
  LLMResponseCacheEntry,
  LLMResponseCacheStore,
  NewCacheEntry,
} from "@domain/ports/LLMResponseCacheStore";

export class InMemoryLLMResponseCacheStore implements LLMResponseCacheStore {
  entries = new Map<string, LLMResponseCacheEntry>();

  async get(inputHash: string): Promise<LLMResponseCacheEntry | null> {
    return this.entries.get(inputHash) ?? null;
  }

  async set(entry: NewCacheEntry): Promise<void> {
    // Mirror ON CONFLICT DO NOTHING semantics: first write wins.
    if (this.entries.has(entry.inputHash)) return;
    const now = new Date();
    this.entries.set(entry.inputHash, {
      ...entry,
      firstSeenAt: now,
      lastUsedAt: now,
      hitCount: 0,
    });
  }

  async touchHit(inputHash: string): Promise<void> {
    const e = this.entries.get(inputHash);
    if (!e) return;
    e.hitCount += 1;
    e.lastUsedAt = new Date();
  }

  reset(): void {
    this.entries.clear();
  }
}
