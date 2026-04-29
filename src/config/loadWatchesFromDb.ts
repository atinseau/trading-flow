import { watchConfigs } from "@adapters/persistence/schema";
import { WatchesConfigError } from "@config/WatchesConfigError";
import { type WatchConfig, WatchSchema } from "@domain/schemas/WatchesConfig";
import { isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

export async function loadWatchesFromDb(pool: pg.Pool): Promise<WatchConfig[]> {
  const db = drizzle(pool);
  const rows = await db.select().from(watchConfigs).where(isNull(watchConfigs.deletedAt));
  return rows.map((r) => {
    const result = WatchSchema.safeParse(r.config);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new WatchesConfigError(`Invalid watch_configs row "${r.id}":\n${issues}`);
    }
    return result.data;
  });
}
