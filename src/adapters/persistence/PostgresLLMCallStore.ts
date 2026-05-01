import type { LLMCall, LLMCallStore } from "@domain/ports/LLMCallStore";
import type { drizzle } from "drizzle-orm/node-postgres";
import { llmCalls } from "./schema";

type DB = ReturnType<typeof drizzle>;

export class PostgresLLMCallStore implements LLMCallStore {
  constructor(private db: DB) {}

  async record(call: LLMCall): Promise<void> {
    await this.db.insert(llmCalls).values({
      watchId: call.watchId,
      setupId: call.setupId,
      stage: call.stage,
      provider: call.provider,
      model: call.model,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheCreateTokens: call.cacheCreateTokens,
      costUsd: String(call.costUsd),
      latencyMs: call.latencyMs ?? null,
      occurredAt: call.occurredAt ?? new Date(),
    });
  }
}
