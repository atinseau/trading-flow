import { llmResponseCache } from "@adapters/persistence/schema";
import type {
  LLMResponseCacheEntry,
  LLMResponseCacheStore,
  NewCacheEntry,
} from "@domain/ports/LLMResponseCacheStore";
import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;
type Row = typeof llmResponseCache.$inferSelect;

function rowToEntry(row: Row): LLMResponseCacheEntry {
  return {
    inputHash: row.inputHash,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    responseJson: row.responseJson,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    costUsd: Number(row.costUsd),
    firstSeenAt: row.firstSeenAt,
    lastUsedAt: row.lastUsedAt,
    hitCount: row.hitCount,
  };
}

export class PostgresLLMResponseCacheStore implements LLMResponseCacheStore {
  constructor(private readonly db: DB) {}

  async get(inputHash: string): Promise<LLMResponseCacheEntry | null> {
    const rows = await this.db
      .select()
      .from(llmResponseCache)
      .where(eq(llmResponseCache.inputHash, inputHash))
      .limit(1);
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async set(entry: NewCacheEntry): Promise<void> {
    // ON CONFLICT DO NOTHING — concurrent writes of the same hash both
    // observe a valid cached row afterwards; the first writer's row wins.
    await this.db
      .insert(llmResponseCache)
      .values({
        inputHash: entry.inputHash,
        provider: entry.provider,
        model: entry.model,
        promptVersion: entry.promptVersion,
        responseJson: entry.responseJson,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        costUsd: entry.costUsd.toString(),
      })
      .onConflictDoNothing({ target: llmResponseCache.inputHash });
  }

  async touchHit(inputHash: string): Promise<void> {
    await this.db
      .update(llmResponseCache)
      .set({
        hitCount: sql`${llmResponseCache.hitCount} + 1`,
        lastUsedAt: new Date(),
      })
      .where(eq(llmResponseCache.inputHash, inputHash));
  }
}
