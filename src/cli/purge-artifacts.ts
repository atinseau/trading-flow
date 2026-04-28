import { artifacts, events, setups } from "@adapters/persistence/schema";
import { TERMINAL_STATUSES } from "@domain/state-machine/setupTransitions";
import { getLogger } from "@observability/logger";
import { and, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const log = getLogger({ component: "purge-artifacts-cli" });

const olderThanDaysArg = process.argv.find((a) => a.startsWith("--older-than-days="))?.slice(18);
const olderThanDays = olderThanDaysArg ? Number(olderThanDaysArg) : null;
if (olderThanDays == null || Number.isNaN(olderThanDays)) {
  log.error("Usage: purge-artifacts --older-than-days=<N> [--dry-run]");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

const url = process.env.DATABASE_URL;
if (!url) {
  log.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

const cutoff = new Date(Date.now() - olderThanDays * 86400_000);
log.info({ cutoff: cutoff.toISOString(), dryRun }, "Purge starting");

// Find candidate artifacts: older than cutoff, NOT referenced by an event whose setup is still alive
const terminalArr = [...TERMINAL_STATUSES];

// Approach: select artifacts where created_at < cutoff
//   AND (event_id IS NULL OR the event's setup is in a terminal state)
const candidates = await db
  .select({
    id: artifacts.id,
    uri: artifacts.uri,
    eventId: artifacts.eventId,
    bytes: artifacts.bytes,
  })
  .from(artifacts)
  .leftJoin(events, eq(artifacts.eventId, events.id))
  .leftJoin(setups, eq(events.setupId, setups.id))
  .where(
    and(
      lt(artifacts.createdAt, cutoff),
      // Either no event linkage, or the linked setup is terminal
      sql`(${events.id} IS NULL OR ${setups.status} IN (${sql.join(
        terminalArr.map((s) => sql`${s}`),
        sql`, `,
      )}))`,
    ),
  );

log.info({ candidateCount: candidates.length }, "Found purge candidates");

if (dryRun) {
  console.table(
    candidates.slice(0, 20).map((c) => ({
      uri: c.uri.length > 60 ? `${c.uri.slice(0, 57)}...` : c.uri,
      bytes: c.bytes ?? 0,
    })),
  );
  if (candidates.length > 20) console.log(`... and ${candidates.length - 20} more`);
  const totalBytes = candidates.reduce((s, c) => s + (c.bytes ?? 0), 0);
  console.log(
    `\nDry-run: would purge ${candidates.length} artifacts (~${(totalBytes / 1024 / 1024).toFixed(1)} MB)`,
  );
  await pool.end();
  process.exit(0);
}

let deletedFiles = 0;
let deletedRows = 0;
let errorsCount = 0;

for (const c of candidates) {
  // Delete file from disk
  if (c.uri.startsWith("file://")) {
    const path = c.uri.replace(/^file:\/\//, "");
    try {
      await Bun.file(path).delete();
      deletedFiles++;
    } catch (err) {
      log.warn({ uri: c.uri, err: (err as Error).message }, "Could not delete file");
      errorsCount++;
    }
  }
  // Delete DB row
  await db.delete(artifacts).where(eq(artifacts.id, c.id));
  deletedRows++;
}

log.info({ deletedFiles, deletedRows, errorsCount }, "Purge complete");
console.log(`\nPurged ${deletedFiles} files, ${deletedRows} DB rows. ${errorsCount} errors.\n`);

await pool.end();
process.exit(0);
