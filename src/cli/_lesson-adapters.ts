import { PostgresLessonEventStore } from "@adapters/persistence/PostgresLessonEventStore";
import { PostgresLessonStore } from "@adapters/persistence/PostgresLessonStore";
import * as schema from "@adapters/persistence/schema";
import { SystemClock } from "@adapters/time/SystemClock";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export async function wireLessonAdapters() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    lessonStore: new PostgresLessonStore(db),
    lessonEventStore: new PostgresLessonEventStore(db),
    clock: new SystemClock(),
    async close() {
      await pool.end();
    },
  };
}
