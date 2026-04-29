import type { LessonCategory, LessonStatus } from "@domain/feedback/lessonAction";

export type StoredLesson = {
  id: string;
  watchId: string;
  category: LessonCategory;
  status: LessonStatus;
  title: string;
  body: string;
  rationale: string;
  pinned: boolean;
  timesReinforced: number;
  timesUsedInPrompts: number;
  sourceFeedbackEventId: string | null;
  supersedesLessonId: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  deprecatedAt: Date | null;
  promptVersion: string;
};

export type ListActiveQuery = {
  watchId: string;
  category: LessonCategory;
  limit: number;
};

export type CreateLessonInput = {
  id: string;
  watchId: string;
  category: LessonCategory;
  title: string;
  body: string;
  rationale: string;
  promptVersion: string;
  sourceFeedbackEventId?: string | null;
  supersedesLessonId?: string | null;
  status: "PENDING" | "ACTIVE";
};

export type UpdateLessonStatusInput = {
  lessonId: string;
  fromStatus: LessonStatus;
  toStatus: LessonStatus;
  occurredAt: Date;
};

export type RefineLessonInput = {
  newId: string;
  watchId: string;
  category: LessonCategory;
  oldLessonId: string;
  newTitle: string;
  newBody: string;
  rationale: string;
  promptVersion: string;
  sourceFeedbackEventId: string;
};

export interface LessonStore {
  getById(id: string): Promise<StoredLesson | null>;
  listActive(query: ListActiveQuery): Promise<StoredLesson[]>;
  listByStatus(args: {
    watchId?: string;
    category?: LessonCategory;
    status?: LessonStatus;
  }): Promise<StoredLesson[]>;
  create(input: CreateLessonInput): Promise<StoredLesson>;
  updateStatus(input: UpdateLessonStatusInput): Promise<{ updated: boolean }>;
  refineSupersede(input: RefineLessonInput): Promise<{ newLesson: StoredLesson }>;
  incrementUsage(ids: string[]): Promise<void>;
  incrementReinforced(id: string): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<{ updated: boolean }>;
  countActiveByCategory(watchId: string): Promise<Record<LessonCategory, number>>;
}
