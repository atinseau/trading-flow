import type { Clock } from "@domain/ports/Clock";
import type { LessonEventStore } from "@domain/ports/LessonEventStore";
import type { LessonStore } from "@domain/ports/LessonStore";

export type LessonApprovalUseCase = {
  handle(input: {
    action: "approve" | "reject";
    lessonId: string;
    via?: "telegram" | "cli" | "web";
    reason?: string;
  }): Promise<{ updated: boolean; finalStatus: "ACTIVE" | "REJECTED" | "noop" }>;
};

export function buildLessonApprovalUseCase(deps: {
  lessonStore: LessonStore;
  lessonEventStore: LessonEventStore;
  editLessonMessage: (args: {
    chatId: string;
    msgId: number;
    finalState: "approved" | "rejected" | "no_longer_pending";
    atIso: string;
  }) => Promise<void>;
  chatId: string;
  notificationMsgIdByLessonId: (lessonId: string) => Promise<number | null>;
  clock: Clock;
}): LessonApprovalUseCase {
  return {
    async handle(input) {
      const lesson = await deps.lessonStore.getById(input.lessonId);
      if (!lesson) return { updated: false, finalStatus: "noop" };

      const now = deps.clock.now();
      const isApprove = input.action === "approve";
      const targetStatus = isApprove ? "ACTIVE" : "REJECTED";

      const r = await deps.lessonStore.updateStatus({
        lessonId: input.lessonId,
        fromStatus: "PENDING",
        toStatus: targetStatus,
        occurredAt: now,
      });
      if (!r.updated) {
        const msgId = await deps.notificationMsgIdByLessonId(input.lessonId);
        if (msgId !== null) {
          await deps.editLessonMessage({
            chatId: deps.chatId,
            msgId,
            finalState: "no_longer_pending",
            atIso: now.toISOString(),
          });
        }
        return { updated: false, finalStatus: "noop" };
      }

      // If approve and the lesson supersedes another, archive the old one
      if (isApprove && lesson.supersedesLessonId) {
        await deps.lessonStore.updateStatus({
          lessonId: lesson.supersedesLessonId,
          fromStatus: "ACTIVE",
          toStatus: "ARCHIVED",
          occurredAt: now,
        });
      }

      await deps.lessonEventStore.append({
        watchId: lesson.watchId,
        lessonId: input.lessonId,
        type: isApprove ? "HumanApproved" : "HumanRejected",
        actor: `human:${input.via ?? "telegram"}`,
        payload: isApprove
          ? { type: "HumanApproved", data: { via: input.via ?? "telegram" } }
          : {
              type: "HumanRejected",
              data: { via: input.via ?? "telegram", reason: input.reason },
            },
      });

      const msgId = await deps.notificationMsgIdByLessonId(input.lessonId);
      if (msgId !== null) {
        await deps.editLessonMessage({
          chatId: deps.chatId,
          msgId,
          finalState: isApprove ? "approved" : "rejected",
          atIso: now.toISOString(),
        });
      }

      return { updated: true, finalStatus: targetStatus };
    },
  };
}
