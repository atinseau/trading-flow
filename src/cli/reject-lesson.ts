#!/usr/bin/env bun
import { buildLessonApprovalUseCase } from "@domain/feedback/lessonApprovalUseCase";
import { wireLessonAdapters } from "./_lesson-adapters";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: reject-lesson.ts <lesson-id> [--reason=text]");
    process.exit(2);
  }
  const reasonArg = process.argv.find((a) => a.startsWith("--reason="));
  const reason = reasonArg?.slice(9);
  const wiring = await wireLessonAdapters();
  try {
    const useCase = buildLessonApprovalUseCase({
      lessonStore: wiring.lessonStore,
      lessonEventStore: wiring.lessonEventStore,
      editLessonMessage: async () => {},
      chatId: "cli",
      notificationMsgIdByLessonId: async () => null,
      clock: wiring.clock,
    });
    const r = await useCase.handle({ action: "reject", lessonId: id, via: "cli", reason });
    if (r.updated) {
      console.log(`rejected: lesson ${id} -> ${r.finalStatus}`);
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
