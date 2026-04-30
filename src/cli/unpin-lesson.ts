#!/usr/bin/env bun
import { wireLessonAdapters } from "./_lesson-adapters";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: unpin-lesson.ts <lesson-id>");
    process.exit(2);
  }
  const wiring = await wireLessonAdapters();
  try {
    const r = await wiring.lessonStore.setPinned(id, false);
    if (!r.updated) {
      console.error(`Lesson ${id} not found`);
      process.exit(1);
    }
    const lesson = await wiring.lessonStore.getById(id);
    if (lesson) {
      await wiring.lessonEventStore.append({
        watchId: lesson.watchId,
        lessonId: id,
        type: "HumanUnpinned",
        actor: "human:cli",
        payload: { type: "HumanUnpinned", data: { via: "cli" } },
      });
    }
    console.log(`unpinned: lesson ${id}`);
  } finally {
    await wiring.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
