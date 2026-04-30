#!/usr/bin/env bun
import { buildLessonApprovalUseCase } from "@domain/feedback/lessonApprovalUseCase";
import { wireLessonAdapters } from "./_lesson-adapters";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: approve-lesson.ts <lesson-id>");
    process.exit(2);
  }
  const wiring = await wireLessonAdapters();
  try {
    const useCase = buildLessonApprovalUseCase({
      lessonStore: wiring.lessonStore,
      lessonEventStore: wiring.lessonEventStore,
      editLessonMessage: async () => {}, // CLI does not touch Telegram
      chatId: "cli",
      notificationMsgIdByLessonId: async () => null,
      clock: wiring.clock,
    });
    const r = await useCase.handle({ action: "approve", lessonId: id, via: "cli" });
    if (r.updated) {
      console.log(`approved: lesson ${id} -> ${r.finalStatus}`);
    } else {
      console.log("(no change - lesson is not PENDING)");
    }
  } finally {
    await wiring.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
