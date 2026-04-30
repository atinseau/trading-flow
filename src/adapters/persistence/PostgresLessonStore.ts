import { lessons } from "@adapters/persistence/schema";
import type { LessonCategory, LessonStatus } from "@domain/feedback/lessonAction";
import type {
  CreateLessonInput,
  LessonStore,
  ListActiveQuery,
  RefineLessonInput,
  StoredLesson,
  UpdateLessonStatusInput,
} from "@domain/ports/LessonStore";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;
type Row = typeof lessons.$inferSelect;

function rowToStored(row: Row): StoredLesson {
  return {
    id: row.id,
    watchId: row.watchId,
    category: row.category as LessonCategory,
    status: row.status as LessonStatus,
    title: row.title,
    body: row.body,
    rationale: row.rationale,
    pinned: row.pinned,
    timesReinforced: row.timesReinforced,
    timesUsedInPrompts: row.timesUsedInPrompts,
    sourceFeedbackEventId: row.sourceFeedbackEventId,
    supersedesLessonId: row.supersedesLessonId,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    deprecatedAt: row.deprecatedAt,
    promptVersion: row.promptVersion,
  };
}

export class PostgresLessonStore implements LessonStore {
  constructor(private readonly db: DB) {}

  async getById(id: string): Promise<StoredLesson | null> {
    const rows = await this.db.select().from(lessons).where(eq(lessons.id, id)).limit(1);
    return rows[0] ? rowToStored(rows[0]) : null;
  }

  async listActive(query: ListActiveQuery): Promise<StoredLesson[]> {
    const rows = await this.db
      .select()
      .from(lessons)
      .where(
        and(
          eq(lessons.watchId, query.watchId),
          eq(lessons.category, query.category),
          eq(lessons.status, "ACTIVE"),
        ),
      )
      .orderBy(desc(lessons.timesReinforced), desc(lessons.createdAt))
      .limit(query.limit);
    return rows.map(rowToStored);
  }

  async listByStatus(args: {
    watchId?: string;
    category?: LessonCategory;
    status?: LessonStatus;
  }): Promise<StoredLesson[]> {
    const conditions = [];
    if (args.watchId) conditions.push(eq(lessons.watchId, args.watchId));
    if (args.category) conditions.push(eq(lessons.category, args.category));
    if (args.status) conditions.push(eq(lessons.status, args.status));
    const q = this.db.select().from(lessons);
    const rows = conditions.length > 0 ? await q.where(and(...conditions)) : await q;
    return rows.map(rowToStored);
  }

  async create(input: CreateLessonInput): Promise<StoredLesson> {
    const [row] = await this.db
      .insert(lessons)
      .values({
        id: input.id,
        watchId: input.watchId,
        category: input.category,
        status: input.status,
        title: input.title,
        body: input.body,
        rationale: input.rationale,
        promptVersion: input.promptVersion,
        sourceFeedbackEventId: input.sourceFeedbackEventId ?? null,
        supersedesLessonId: input.supersedesLessonId ?? null,
        activatedAt: input.status === "ACTIVE" ? sql`now()` : null,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return rowToStored(row);
  }

  async updateStatus(input: UpdateLessonStatusInput) {
    const setExtras: Record<string, unknown> = { status: input.toStatus };
    if (input.toStatus === "ACTIVE") setExtras.activatedAt = input.occurredAt;
    if (input.toStatus === "DEPRECATED") setExtras.deprecatedAt = input.occurredAt;

    const result = await this.db
      .update(lessons)
      .set(setExtras)
      .where(and(eq(lessons.id, input.lessonId), eq(lessons.status, input.fromStatus)))
      .returning({ id: lessons.id });
    return { updated: result.length > 0 };
  }

  async refineSupersede(input: RefineLessonInput) {
    const newLesson = await this.create({
      id: input.newId,
      watchId: input.watchId,
      category: input.category,
      title: input.newTitle,
      body: input.newBody,
      rationale: input.rationale,
      promptVersion: input.promptVersion,
      sourceFeedbackEventId: input.sourceFeedbackEventId,
      supersedesLessonId: input.oldLessonId,
      status: "PENDING",
    });
    return { newLesson };
  }

  async incrementUsage(ids: string[]) {
    if (ids.length === 0) return;
    await this.db
      .update(lessons)
      .set({ timesUsedInPrompts: sql`${lessons.timesUsedInPrompts} + 1` })
      .where(inArray(lessons.id, ids));
  }

  async incrementReinforced(id: string) {
    await this.db
      .update(lessons)
      .set({ timesReinforced: sql`${lessons.timesReinforced} + 1` })
      .where(eq(lessons.id, id));
  }

  async setPinned(id: string, pinned: boolean) {
    const r = await this.db
      .update(lessons)
      .set({ pinned })
      .where(eq(lessons.id, id))
      .returning({ id: lessons.id });
    return { updated: r.length > 0 };
  }

  async countActiveByCategory(watchId: string) {
    const rows = await this.db
      .select({ category: lessons.category, count: sql<number>`count(*)::int` })
      .from(lessons)
      .where(and(eq(lessons.watchId, watchId), eq(lessons.status, "ACTIVE")))
      .groupBy(lessons.category);
    const out = { detecting: 0, reviewing: 0, finalizing: 0 } as Record<LessonCategory, number>;
    for (const r of rows) {
      if (r.category === "detecting" || r.category === "reviewing" || r.category === "finalizing") {
        out[r.category] = r.count;
      }
    }
    return out;
  }
}
