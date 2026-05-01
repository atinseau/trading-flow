/**
 * nuke-trading-flow.ts
 *
 * One-shot wipe of all runtime data from the trading-flow database.
 * Schema (migrations) are NOT touched — only row data.
 *
 * Usage:
 *   bun run scripts/nuke-trading-flow.ts --yes
 *
 * Requires DATABASE_URL env var.
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const TABLES = [
  "watch_states",
  "setups",
  "events",
  "artifacts",
  "tick_snapshots",
  "watch_configs",
  "watch_config_revisions",
  "lessons",
  "lesson_events",
  "llm_calls",
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const confirm = process.argv.includes("--yes");
  if (!confirm) {
    console.error("This will DELETE ALL DATA. Pass --yes to confirm.");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  for (const t of TABLES) {
    console.log(`TRUNCATE ${t}`);
    await db.execute(sql.raw(`TRUNCATE TABLE "${t}" CASCADE;`));
  }

  await pool.end();
  console.log("✓ all rows wiped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
