import { events, setups } from "@adapters/persistence/schema";
import { getLogger } from "@observability/logger";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const log = getLogger({ component: "show-setup" });

const setupId = process.argv[2];
if (!setupId) {
  log.error("Usage: show-setup <id>");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  log.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

const [s] = await db.select().from(setups).where(eq(setups.id, setupId));
if (!s) {
  log.error({ setupId }, "Setup not found");
  process.exit(2);
}

const setupLog = log.child({ setupId });
setupLog.info({ setup: s }, "setup details");

const evts = await db
  .select()
  .from(events)
  .where(eq(events.setupId, setupId))
  .orderBy(events.sequence);
setupLog.info({ eventCount: evts.length }, "events for setup");
for (const e of evts) {
  setupLog.info(
    {
      sequence: e.sequence,
      type: e.type,
      scoreAfter: e.scoreAfter,
      statusBefore: e.statusBefore,
      statusAfter: e.statusAfter,
    },
    "event",
  );
}

await pool.end();
