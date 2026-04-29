import { watchConfigs } from "@adapters/persistence/schema";
import { type WatchConfig, WatchSchema } from "@domain/schemas/WatchesConfig";
import { isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

export async function loadWatchesFromDb(pool: pg.Pool): Promise<WatchConfig[]> {
  const db = drizzle(pool);
  const rows = await db.select().from(watchConfigs).where(isNull(watchConfigs.deletedAt));
  return rows.map((r) => WatchSchema.parse(r.config));
}
