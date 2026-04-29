#!/usr/bin/env bun
import type { LessonCategory, LessonStatus } from "@domain/feedback/lessonAction";
import { wireLessonAdapters } from "./_lesson-adapters";

function parseArgs(argv: string[]) {
  const out: {
    watch?: string;
    category?: LessonCategory;
    status?: LessonStatus;
    json?: boolean;
  } = {};
  for (const a of argv) {
    if (a.startsWith("--watch=")) out.watch = a.slice(8);
    else if (a.startsWith("--category=")) out.category = a.slice(11) as LessonCategory;
    else if (a.startsWith("--status=")) out.status = a.slice(9) as LessonStatus;
    else if (a === "--json") out.json = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wiring = await wireLessonAdapters();
  try {
    const rows = await wiring.lessonStore.listByStatus({
      watchId: args.watch,
      category: args.category,
      status: args.status,
    });
    if (args.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("(no lessons match)");
      return;
    }
    for (const r of rows) {
      const pinned = r.pinned ? " [pinned]" : "";
      console.log(
        `${r.id}  ${r.watchId}  ${r.category}  ${r.status}${pinned}  reinforced=${r.timesReinforced}  used=${r.timesUsedInPrompts}`,
      );
      console.log(`  ${r.title}`);
    }
  } finally {
    await wiring.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
