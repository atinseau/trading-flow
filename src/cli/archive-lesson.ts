#!/usr/bin/env bun
import { wireLessonAdapters } from "./_lesson-adapters";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: archive-lesson.ts <lesson-id> [--reason=text]");
    process.exit(2);
  }
  const reasonArg = process.argv.find((a) => a.startsWith("--reason="));
  const reason = reasonArg?.slice(9);
  const wiring = await wireLessonAdapters();
  try {
    const lesson = await wiring.lessonStore.getById(id);
    if (!lesson) {
      console.error(`Lesson ${id} not found`);
      process.exit(1);
    }
    const r = await wiring.lessonStore.updateStatus({
      lessonId: id,
      fromStatus: "ACTIVE",
      toStatus: "ARCHIVED",
      occurredAt: wiring.clock.now(),
    });
    if (!r.updated) {
      console.error("(no change - lesson is not ACTIVE)");
      process.exit(1);
    }
    await wiring.lessonEventStore.append({
      watchId: lesson.watchId,
      lessonId: id,
      type: "HumanArchived",
      actor: "human:cli",
      payload: { type: "HumanArchived", data: { via: "cli", reason } },
    });
    console.log(`archived: lesson ${id} -> ARCHIVED`);
  } finally {
    await wiring.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
