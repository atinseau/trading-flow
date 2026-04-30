import { PostgresLessonEventStore } from "@adapters/persistence/PostgresLessonEventStore";
import { PostgresLessonStore } from "@adapters/persistence/PostgresLessonStore";
import { SystemClock } from "@adapters/time/SystemClock";
import { NotFoundError, requireParam, safeHandler } from "@client/api/safeHandler";
import type { LessonCategory, LessonStatus } from "@domain/feedback/lessonAction";
import { buildLessonApprovalUseCase } from "@domain/feedback/lessonApprovalUseCase";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

type SortableLesson = {
  pinned: boolean;
  timesReinforced: number;
  createdAt: Date;
};

/**
 * Stable display order: pinned first, then most-reinforced, then most-recent.
 * Exported for tests.
 */
export function compareLessonsForDisplay(a: SortableLesson, b: SortableLesson): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.timesReinforced !== b.timesReinforced) return b.timesReinforced - a.timesReinforced;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

export function makeLessonsApi(deps: { db: DB }) {
  const { db } = deps;
  const lessonStore = new PostgresLessonStore(db);
  const lessonEventStore = new PostgresLessonEventStore(db);
  const clock = new SystemClock();

  const approvalUseCase = buildLessonApprovalUseCase({
    lessonStore,
    lessonEventStore,
    editLessonMessage: async () => {},
    chatId: "web",
    notificationMsgIdByLessonId: async () => null,
    clock,
  });

  return {
    listAll: safeHandler(async (req) => {
      const url = new URL(req.url);
      const status = url.searchParams.get("status") as LessonStatus | null;
      const category = url.searchParams.get("category") as LessonCategory | null;
      const rows = await lessonStore.listByStatus({
        status: status ?? undefined,
        category: category ?? undefined,
      });
      rows.sort(compareLessonsForDisplay);
      return Response.json(rows);
    }),

    listForWatch: safeHandler(async (req, params) => {
      const watchId = requireParam(params, "id");
      const url = new URL(req.url);
      const status = url.searchParams.get("status") as LessonStatus | null;
      const category = url.searchParams.get("category") as LessonCategory | null;
      const rows = await lessonStore.listByStatus({
        watchId,
        status: status ?? undefined,
        category: category ?? undefined,
      });
      // Sort: pinned first, then timesReinforced desc, then createdAt desc.
      rows.sort(compareLessonsForDisplay);
      return Response.json(rows);
    }),

    countsForWatch: safeHandler(async (_req, params) => {
      const watchId = requireParam(params, "id");
      const rows = await lessonStore.listByStatus({ watchId });
      const counts: Record<LessonStatus, number> = {
        PENDING: 0,
        ACTIVE: 0,
        REJECTED: 0,
        DEPRECATED: 0,
        ARCHIVED: 0,
      };
      let pinned = 0;
      for (const r of rows) {
        counts[r.status]++;
        if (r.pinned) pinned++;
      }
      return Response.json({ ...counts, pinned, total: rows.length });
    }),

    countsGlobal: safeHandler(async () => {
      const rows = await lessonStore.listByStatus({});
      const counts: Record<LessonStatus, number> = {
        PENDING: 0,
        ACTIVE: 0,
        REJECTED: 0,
        DEPRECATED: 0,
        ARCHIVED: 0,
      };
      for (const r of rows) counts[r.status]++;
      return Response.json({ ...counts, total: rows.length });
    }),

    get: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const lesson = await lessonStore.getById(id);
      if (!lesson) throw new NotFoundError(`lesson ${id} not found`);
      const events = await lessonEventStore.listForLesson(id);
      return Response.json({ lesson, events });
    }),

    listEventsForSetup: safeHandler(async (_req, params) => {
      const setupId = requireParam(params, "id");
      const events = await lessonEventStore.listForSetup(setupId);
      // Resolve associated lessons.
      const lessonIds = [...new Set(events.map((e) => e.lessonId).filter((x): x is string => !!x))];
      const lessons = await Promise.all(lessonIds.map((id) => lessonStore.getById(id)));
      return Response.json({
        events,
        lessons: lessons.filter((l) => l !== null),
      });
    }),

    approve: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const r = await approvalUseCase.handle({ action: "approve", lessonId: id, via: "web" });
      return Response.json(r);
    }),

    reject: safeHandler(async (req, params) => {
      const id = requireParam(params, "id");
      const body = (await req.json().catch(() => ({}))) as { reason?: string };
      const r = await approvalUseCase.handle({
        action: "reject",
        lessonId: id,
        via: "web",
        reason: body.reason,
      });
      return Response.json(r);
    }),

    pin: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const r = await lessonStore.setPinned(id, true);
      if (!r.updated) throw new NotFoundError(`lesson ${id} not found`);
      const lesson = await lessonStore.getById(id);
      if (lesson) {
        await lessonEventStore.append({
          watchId: lesson.watchId,
          lessonId: id,
          type: "HumanPinned",
          actor: "human:web",
          payload: { type: "HumanPinned", data: { via: "web" } },
        });
      }
      return Response.json({ updated: true });
    }),

    unpin: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const r = await lessonStore.setPinned(id, false);
      if (!r.updated) throw new NotFoundError(`lesson ${id} not found`);
      const lesson = await lessonStore.getById(id);
      if (lesson) {
        await lessonEventStore.append({
          watchId: lesson.watchId,
          lessonId: id,
          type: "HumanUnpinned",
          actor: "human:web",
          payload: { type: "HumanUnpinned", data: { via: "web" } },
        });
      }
      return Response.json({ updated: true });
    }),

    archive: safeHandler(async (req, params) => {
      const id = requireParam(params, "id");
      const body = (await req.json().catch(() => ({}))) as { reason?: string };
      const lesson = await lessonStore.getById(id);
      if (!lesson) throw new NotFoundError(`lesson ${id} not found`);
      const r = await lessonStore.updateStatus({
        lessonId: id,
        fromStatus: "ACTIVE",
        toStatus: "ARCHIVED",
        occurredAt: clock.now(),
      });
      if (!r.updated) return Response.json({ updated: false, reason: "not ACTIVE" });
      await lessonEventStore.append({
        watchId: lesson.watchId,
        lessonId: id,
        type: "HumanArchived",
        actor: "human:web",
        payload: { type: "HumanArchived", data: { via: "web", reason: body.reason } },
      });
      return Response.json({ updated: true });
    }),
  };
}
