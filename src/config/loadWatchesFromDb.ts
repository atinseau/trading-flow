import { PostgresWatchRepository } from "@adapters/persistence/PostgresWatchRepository";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { getLogger } from "@observability/logger";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

const log = getLogger({ component: "load-watches-from-db" });

/**
 * Loads valid watches from the watch_configs table.
 *
 * Invalid rows (Zod validation failures) are SKIPPED with a warning log.
 * This prevents a single bad row from crashing the entire boot.
 *
 * Soft-deleted rows (deletedAt !== null) are excluded by the repository.
 */
export async function loadWatchesFromDb(pool: pg.Pool): Promise<WatchConfig[]> {
  const repo = new PostgresWatchRepository(drizzle(pool));
  const all = await repo.findAllWithValidation();
  const valid: WatchConfig[] = [];
  for (const r of all) {
    if (r.watch) {
      valid.push(r.watch);
    } else {
      log.warn({ watchId: r.id, error: r.error }, "skipping invalid watch_configs row");
    }
  }
  return valid;
}
