import type { LLMUsageStore } from "@domain/ports/LLMUsageStore";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { llmCalls } from "./schema";

type DB = ReturnType<typeof drizzle>;

export class PostgresLLMUsageStore implements LLMUsageStore {
  constructor(private db: DB) {}

  async getCallsToday(providerName: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startOfNextDay = new Date(startOfDay);
    startOfNextDay.setUTCDate(startOfNextDay.getUTCDate() + 1);

    const [row] = await this.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(llmCalls)
      .where(
        and(
          eq(llmCalls.provider, providerName),
          gte(llmCalls.occurredAt, startOfDay),
          lt(llmCalls.occurredAt, startOfNextDay),
        ),
      );
    return Number(row?.count ?? 0);
  }

  async getSpentMonthUsd(providerName: string): Promise<number> {
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const startOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const [row] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${llmCalls.costUsd}), 0)`,
      })
      .from(llmCalls)
      .where(
        and(
          eq(llmCalls.provider, providerName),
          gte(llmCalls.occurredAt, startOfMonth),
          lt(llmCalls.occurredAt, startOfNextMonth),
        ),
      );
    return Number(row?.total ?? 0);
  }
}
