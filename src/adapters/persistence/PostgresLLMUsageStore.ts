import type { LLMUsageStore } from "@domain/ports/LLMUsageStore";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { events } from "./schema";

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
      .from(events)
      .where(
        and(
          eq(events.provider, providerName),
          gte(events.occurredAt, startOfDay),
          lt(events.occurredAt, startOfNextDay),
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
        total: sql<string>`COALESCE(SUM(${events.costUsd}), 0)`,
      })
      .from(events)
      .where(
        and(
          eq(events.provider, providerName),
          gte(events.occurredAt, startOfMonth),
          lt(events.occurredAt, startOfNextMonth),
        ),
      );
    return Number(row?.total ?? 0);
  }
}
