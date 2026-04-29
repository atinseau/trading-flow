import type { LessonCategory, LessonStatus } from "@domain/feedback/lessonAction";
import type {
  CreateLessonInput,
  ListActiveQuery,
  LessonStore,
  RefineLessonInput,
  StoredLesson,
  UpdateLessonStatusInput,
} from "@domain/ports/LessonStore";

export class InMemoryLessonStore implements LessonStore {
  private rows: StoredLesson[] = [];

  async getById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async listActive(query: ListActiveQuery): Promise<StoredLesson[]> {
    return this.rows
      .filter(
        (r) =>
          r.watchId === query.watchId && r.category === query.category && r.status === "ACTIVE",
      )
      .sort((a, b) => {
        if (b.timesReinforced !== a.timesReinforced) {
          return b.timesReinforced - a.timesReinforced;
        }
        return b.createdAt.getTime() - a.createdAt.getTime();
      })
      .slice(0, query.limit);
  }

  async listByStatus(args: { watchId?: string; category?: LessonCategory; status?: LessonStatus }) {
    return this.rows.filter(
      (r) =>
        (!args.watchId || r.watchId === args.watchId) &&
        (!args.category || r.category === args.category) &&
        (!args.status || r.status === args.status),
    );
  }

  async create(input: CreateLessonInput): Promise<StoredLesson> {
    const now = new Date();
    const lesson: StoredLesson = {
      id: input.id,
      watchId: input.watchId,
      category: input.category,
      status: input.status,
      title: input.title,
      body: input.body,
      rationale: input.rationale,
      pinned: false,
      timesReinforced: 0,
      timesUsedInPrompts: 0,
      sourceFeedbackEventId: input.sourceFeedbackEventId ?? null,
      supersedesLessonId: input.supersedesLessonId ?? null,
      createdAt: now,
      activatedAt: input.status === "ACTIVE" ? now : null,
      deprecatedAt: null,
      promptVersion: input.promptVersion,
    };
    this.rows.push(lesson);
    return lesson;
  }

  async updateStatus(input: UpdateLessonStatusInput) {
    const i = this.rows.findIndex((r) => r.id === input.lessonId && r.status === input.fromStatus);
    if (i < 0) return { updated: false };
    const r = this.rows[i];
    if (!r) return { updated: false };
    r.status = input.toStatus;
    if (input.toStatus === "ACTIVE") r.activatedAt = input.occurredAt;
    if (input.toStatus === "DEPRECATED") r.deprecatedAt = input.occurredAt;
    return { updated: true };
  }

  async refineSupersede(input: RefineLessonInput) {
    // Match Postgres lenience: no FK on supersedes_lesson_id, so we don't reject
    // a missing old lesson. Caller is responsible for passing a valid id.
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
    for (const id of ids) {
      const r = this.rows.find((x) => x.id === id);
      if (r) r.timesUsedInPrompts += 1;
    }
  }

  async incrementReinforced(id: string) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.timesReinforced += 1;
  }

  async setPinned(id: string, pinned: boolean) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return { updated: false };
    r.pinned = pinned;
    return { updated: true };
  }

  async countActiveByCategory(watchId: string) {
    const counts: Record<LessonCategory, number> = {
      detecting: 0,
      reviewing: 0,
      finalizing: 0,
    };
    for (const r of this.rows) {
      if (r.watchId === watchId && r.status === "ACTIVE") {
        counts[r.category] += 1;
      }
    }
    return counts;
  }
}
