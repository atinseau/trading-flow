import { lessonEvents } from "@adapters/persistence/schema";
import type {
  AppendLessonEventInput,
  LessonEventStore,
  StoredLessonEvent,
} from "@domain/ports/LessonEventStore";
import { type LessonEventPayload, LessonEventPayloadSchema } from "@domain/schemas/FeedbackOutput";
import { and, asc, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;
type Row = typeof lessonEvents.$inferSelect;

function rowToStored(row: Row): StoredLessonEvent {
  return {
    id: row.id,
    watchId: row.watchId,
    lessonId: row.lessonId,
    sequence: row.sequence,
    type: row.type as LessonEventPayload["type"],
    actor: row.actor,
    triggerSetupId: row.triggerSetupId,
    triggerCloseReason: row.triggerCloseReason,
    payload: LessonEventPayloadSchema.parse(row.payload),
    occurredAt: row.occurredAt,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    inputHash: row.inputHash,
    costUsd: row.costUsd != null ? Number(row.costUsd) : null,
    latencyMs: row.latencyMs,
  };
}

export class PostgresLessonEventStore implements LessonEventStore {
  constructor(private readonly db: DB) {}

  async append(input: AppendLessonEventInput): Promise<StoredLessonEvent> {
    return await this.db.transaction(async (tx) => {
      // Intentionally non-locking SELECT under READ COMMITTED: concurrent
      // appends are serialized by the UNIQUE(watch_id, sequence) index, and
      // the losing transaction surfaces a Postgres unique_violation (23505)
      // which the calling Temporal activity treats as a transient retry.
      // SELECT … FOR UPDATE would serialize all writes — explicitly avoided.
      const seqRows = await tx.execute<{ next: number }>(sql`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next
        FROM lesson_events
        WHERE watch_id = ${input.watchId}
      `);
      const next = Number(seqRows.rows[0]?.next ?? 1);
      const [row] = await tx
        .insert(lessonEvents)
        .values({
          watchId: input.watchId,
          lessonId: input.lessonId ?? null,
          sequence: next,
          type: input.type,
          actor: input.actor,
          triggerSetupId: input.triggerSetupId ?? null,
          triggerCloseReason: input.triggerCloseReason ?? null,
          payload: input.payload,
          provider: input.provider ?? null,
          model: input.model ?? null,
          promptVersion: input.promptVersion ?? null,
          inputHash: input.inputHash ?? null,
          costUsd: input.costUsd != null ? String(input.costUsd) : null,
          latencyMs: input.latencyMs ?? null,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return rowToStored(row);
    });
  }

  async findByInputHash(args: { watchId: string; inputHash: string }) {
    const rows = await this.db
      .select()
      .from(lessonEvents)
      .where(
        and(eq(lessonEvents.watchId, args.watchId), eq(lessonEvents.inputHash, args.inputHash)),
      )
      .orderBy(asc(lessonEvents.sequence));
    return rows.map(rowToStored);
  }

  async listForLesson(lessonId: string) {
    const rows = await this.db
      .select()
      .from(lessonEvents)
      .where(eq(lessonEvents.lessonId, lessonId))
      .orderBy(asc(lessonEvents.occurredAt));
    return rows.map(rowToStored);
  }

  async listForSetup(setupId: string) {
    const rows = await this.db
      .select()
      .from(lessonEvents)
      .where(eq(lessonEvents.triggerSetupId, setupId))
      .orderBy(asc(lessonEvents.occurredAt));
    return rows.map(rowToStored);
  }
}
