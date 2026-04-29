import type { LessonEventPayload } from "@domain/schemas/FeedbackOutput";

export type StoredLessonEvent = {
  id: string;
  watchId: string;
  lessonId: string | null;
  sequence: number;
  type: LessonEventPayload["type"];
  actor: string;
  triggerSetupId: string | null;
  triggerCloseReason: string | null;
  payload: LessonEventPayload;
  occurredAt: Date;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  inputHash: string | null;
  costUsd: number | null;
  latencyMs: number | null;
};

export type AppendLessonEventInput = {
  watchId: string;
  lessonId?: string | null;
  type: LessonEventPayload["type"];
  actor: string;
  triggerSetupId?: string | null;
  triggerCloseReason?: string | null;
  payload: LessonEventPayload;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  inputHash?: string | null;
  costUsd?: number | null;
  latencyMs?: number | null;
};

export interface LessonEventStore {
  append(input: AppendLessonEventInput): Promise<StoredLessonEvent>;
  findByInputHash(args: { watchId: string; inputHash: string }): Promise<StoredLessonEvent[]>;
  listForLesson(lessonId: string): Promise<StoredLessonEvent[]>;
  listForSetup(setupId: string): Promise<StoredLessonEvent[]>;
}
