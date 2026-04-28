import { events, setups } from "@adapters/persistence/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const setupId = process.argv[2];
if (!setupId) {
  console.error("Usage: show-setup <id>");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

const [s] = await db.select().from(setups).where(eq(setups.id, setupId));
if (!s) {
  console.error("Setup not found");
  process.exit(2);
}

console.log("=== SETUP ===");
console.log(JSON.stringify(s, null, 2));

const evts = await db
  .select()
  .from(events)
  .where(eq(events.setupId, setupId))
  .orderBy(events.sequence);
console.log(`\n=== ${evts.length} EVENTS ===`);
for (const e of evts) {
  console.log(
    `[${e.sequence}] ${e.type} score=${e.scoreAfter} (${e.statusBefore}→${e.statusAfter})`,
  );
}

await pool.end();
