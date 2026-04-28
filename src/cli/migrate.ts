import { getLogger } from "@observability/logger";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const log = getLogger({ component: "migrate" });

const url = process.env.DATABASE_URL;
if (!url) {
  log.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

log.info("Applying migrations from ./migrations");
await migrate(db, { migrationsFolder: "./migrations" });
log.info("Done.");
await pool.end();
