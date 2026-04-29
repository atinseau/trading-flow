import { events, setups } from "@adapters/persistence/schema";
import { deriveOutcome } from "@domain/services/deriveOutcome";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import { TERMINAL_STATUSES } from "@domain/state-machine/setupTransitions";
import { getLogger } from "@observability/logger";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const log = getLogger({ component: "backfill-outcomes" });

const url = process.env.DATABASE_URL;
if (!url) {
  log.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

const terminalArr = [...TERMINAL_STATUSES] as string[];
const rows = await db
  .select()
  .from(setups)
  .where(and(inArray(setups.status, terminalArr), isNull(setups.outcome)));

log.info({ count: rows.length }, "found terminal setups without outcome");

let updated = 0;
for (const row of rows) {
  const evts = await db
    .select({ type: events.type, sequence: events.sequence })
    .from(events)
    .where(eq(events.setupId, row.id))
    .orderBy(asc(events.sequence));
  const outcome = deriveOutcome(row.status as SetupStatus, evts);
  if (outcome) {
    await db.update(setups).set({ outcome }).where(eq(setups.id, row.id));
    updated++;
  }
}

log.info({ updated, total: rows.length }, "backfill complete");
await pool.end();
process.exit(0);
