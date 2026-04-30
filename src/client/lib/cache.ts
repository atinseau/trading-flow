/**
 * Simple in-memory TTL cache. Single-process — fine because tf-web is one Bun
 * process. For multi-instance prod we'd swap to Redis, but that's overkill
 * for this app's scale.
 */

type Entry<T> = { value: T; expiresAt: number };

export class TTLCache<T> {
  private store = new Map<string, Entry<T>>();
  private hits = 0;
  private misses = 0;

  constructor(public defaultTtlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /** Read-through: returns cached value or runs `fetcher` and caches its result. */
  async getOrFetch(key: string, fetcher: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const fresh = await fetcher();
    this.set(key, fresh, ttlMs);
    return fresh;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  stats() {
    return { size: this.store.size, hits: this.hits, misses: this.misses };
  }
}
