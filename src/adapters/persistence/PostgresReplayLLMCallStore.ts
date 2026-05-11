import { replayLlmCalls } from "@adapters/persistence/schema";
import type {
  CostByStage,
  NewReplayLLMCall,
  ReplayLLMCallStore,
} from "@domain/ports/ReplayLLMCallStore";
import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

export class PostgresReplayLLMCallStore implements ReplayLLMCallStore {
  constructor(private readonly db: DB) {}

  async record(call: NewReplayLLMCall): Promise<void> {
    await this.db.insert(replayLlmCalls).values({
      sessionId: call.sessionId,
      setupId: call.setupId,
      stage: call.stage,
      provider: call.provider,
      model: call.model,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheCreateTokens: call.cacheCreateTokens,
      costUsd: call.costUsd.toString(),
      latencyMs: call.latencyMs ?? null,
      cacheHit: call.cacheHit,
    });
  }

  async costBreakdown(sessionId: string): Promise<CostByStage[]> {
    const rows = await this.db
      .select({
        stage: replayLlmCalls.stage,
        totalCostUsd: sql<string>`SUM(${replayLlmCalls.costUsd}::numeric)::text`,
        calls: sql<number>`COUNT(*)::int`,
        cacheHits: sql<number>`COUNT(*) FILTER (WHERE ${replayLlmCalls.cacheHit} = true)::int`,
      })
      .from(replayLlmCalls)
      .where(eq(replayLlmCalls.sessionId, sessionId))
      .groupBy(replayLlmCalls.stage);

    return rows
      .map((r) => ({
        stage: r.stage,
        totalCostUsd: Number(r.totalCostUsd ?? 0),
        calls: r.calls,
        cacheHits: r.cacheHits,
      }))
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }
}
