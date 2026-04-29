#!/usr/bin/env bun
import { wireLessonAdapters } from "./_lesson-adapters";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: show-lesson.ts <lesson-id> [--json]");
    process.exit(2);
  }
  const json = process.argv.includes("--json");
  const wiring = await wireLessonAdapters();
  try {
    const lesson = await wiring.lessonStore.getById(id);
    if (!lesson) {
      console.error(`Lesson ${id} not found`);
      process.exit(1);
    }
    const events = await wiring.lessonEventStore.listForLesson(id);
    if (json) {
      console.log(JSON.stringify({ lesson, events }, null, 2));
      return;
    }
    console.log(`# ${lesson.title}`);
    console.log("");
    console.log(`watch:        ${lesson.watchId}`);
    console.log(`category:     ${lesson.category}`);
    console.log(`status:       ${lesson.status}${lesson.pinned ? " [pinned]" : ""}`);
    console.log(`reinforced:   ${lesson.timesReinforced}x`);
    console.log(`used:         ${lesson.timesUsedInPrompts}x in prompts`);
    console.log(`createdAt:    ${lesson.createdAt.toISOString()}`);
    if (lesson.activatedAt) console.log(`activatedAt:  ${lesson.activatedAt.toISOString()}`);
    if (lesson.deprecatedAt) console.log(`deprecatedAt: ${lesson.deprecatedAt.toISOString()}`);
    if (lesson.supersedesLessonId) console.log(`supersedes:   ${lesson.supersedesLessonId}`);
    console.log("");
    console.log("## Body");
    console.log(lesson.body);
    console.log("");
    console.log("## Rationale");
    console.log(lesson.rationale);
    console.log("");
    console.log(`## Events (${events.length})`);
    for (const e of events) {
      console.log(`  ${e.occurredAt.toISOString()}  ${e.type}  by ${e.actor}`);
    }
  } finally {
    await wiring.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
