import { randomUUID } from "node:crypto";
import type {
  AppendLessonEventInput,
  LessonEventStore,
  StoredLessonEvent,
} from "@domain/ports/LessonEventStore";

export class InMemoryLessonEventStore implements LessonEventStore {
  private rows: StoredLessonEvent[] = [];
  private seqByWatch = new Map<string, number>();

  async append(input: AppendLessonEventInput): Promise<StoredLessonEvent> {
    const next = (this.seqByWatch.get(input.watchId) ?? 0) + 1;
    this.seqByWatch.set(input.watchId, next);
    const row: StoredLessonEvent = {
      id: randomUUID(),
      watchId: input.watchId,
      lessonId: input.lessonId ?? null,
      sequence: next,
      type: input.type,
      actor: input.actor,
      triggerSetupId: input.triggerSetupId ?? null,
      triggerCloseReason: input.triggerCloseReason ?? null,
      payload: input.payload,
      occurredAt: new Date(),
      provider: input.provider ?? null,
      model: input.model ?? null,
      promptVersion: input.promptVersion ?? null,
      inputHash: input.inputHash ?? null,
      costUsd: input.costUsd ?? null,
      latencyMs: input.latencyMs ?? null,
    };
    this.rows.push(row);
    return row;
  }

  async findByInputHash(args: { watchId: string; inputHash: string }) {
    return this.rows.filter((r) => r.watchId === args.watchId && r.inputHash === args.inputHash);
  }

  async listForLesson(lessonId: string) {
    return this.rows
      .filter((r) => r.lessonId === lessonId)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async listForSetup(setupId: string) {
    return this.rows.filter((r) => r.triggerSetupId === setupId);
  }
}
