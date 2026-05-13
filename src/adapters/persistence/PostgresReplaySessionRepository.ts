import { replaySessions } from "@adapters/persistence/schema";
import type {
  ListFilter,
  NewReplaySessionInput,
  ReplaySessionRepository,
} from "@domain/ports/ReplaySessionRepository";
import type {
  FeedbackMode,
  LessonsMode,
  ReplaySession,
  ReplaySessionStatus,
} from "@domain/replay/ReplaySession";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { and, desc, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;
type Row = typeof replaySessions.$inferSelect;

function rowToSession(row: Row): ReplaySession {
  return {
    id: row.id,
    watchId: row.watchId,
    name: row.name,
    status: row.status as ReplaySessionStatus,
    windowStartAt: row.windowStartAt,
    windowEndAt: row.windowEndAt,
    workflowId: row.workflowId,
    configSnapshot: row.configSnapshot as WatchConfig,
    lessonsMode: row.lessonsMode as LessonsMode,
    feedbackMode: row.feedbackMode as FeedbackMode,
    costCapUsd: Number(row.costCapUsd),
    costUsdSoFar: Number(row.costUsdSoFar),
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresReplaySessionRepository implements ReplaySessionRepository {
  constructor(private readonly db: DB) {}

  async create(input: NewReplaySessionInput): Promise<ReplaySession> {
    const [row] = await this.db
      .insert(replaySessions)
      .values({
        ...(input.id ? { id: input.id } : {}),
        watchId: input.watchId,
        name: input.name,
        status: input.status,
        windowStartAt: input.windowStartAt,
        windowEndAt: input.windowEndAt,
        workflowId: input.workflowId,
        configSnapshot: input.configSnapshot,
        lessonsMode: input.lessonsMode,
        feedbackMode: input.feedbackMode,
        costCapUsd: input.costCapUsd.toString(),
        costUsdSoFar: "0",
      })
      .returning();
    if (!row) throw new Error("INSERT replay_sessions returned no row");
    return rowToSession(row);
  }

  async get(id: string): Promise<ReplaySession | null> {
    const rows = await this.db
      .select()
      .from(replaySessions)
      .where(eq(replaySessions.id, id))
      .limit(1);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async list(filter: ListFilter): Promise<ReplaySession[]> {
    const conditions = [
      filter.watchId ? eq(replaySessions.watchId, filter.watchId) : undefined,
      filter.status ? eq(replaySessions.status, filter.status) : undefined,
    ].filter((x): x is NonNullable<typeof x> => x !== undefined);

    const rows = await this.db
      .select()
      .from(replaySessions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(replaySessions.createdAt))
      .limit(filter.limit ?? 50);
    return rows.map(rowToSession);
  }

  async updateStatus(
    id: string,
    status: ReplaySessionStatus,
    failureReason?: string,
  ): Promise<void> {
    await this.db
      .update(replaySessions)
      .set({
        status,
        failureReason: failureReason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(replaySessions.id, id));
  }

  async incrementCost(id: string, deltaUsd: number): Promise<void> {
    // Atomic increment — two concurrent calls correctly sum via SQL +.
    await this.db
      .update(replaySessions)
      .set({
        costUsdSoFar: sql`${replaySessions.costUsdSoFar}::numeric + ${deltaUsd.toString()}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(replaySessions.id, id));
  }

  async delete(id: string): Promise<void> {
    // Cascade DELETE on replay_events and replay_llm_calls via FK ON DELETE CASCADE.
    await this.db.delete(replaySessions).where(eq(replaySessions.id, id));
  }
}
