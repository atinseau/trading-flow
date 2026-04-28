import { setups } from "@adapters/persistence/schema";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const statusFilter = process.argv.find((a) => a.startsWith("--status="))?.slice(9);
const watchFilter = process.argv.find((a) => a.startsWith("--watch="))?.slice(8);

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

const baseQuery = db.select().from(setups).orderBy(desc(setups.updatedAt)).$dynamic();
const query = statusFilter ? baseQuery.where(eq(setups.status, statusFilter)) : baseQuery;

const rows = await query.limit(100);
const filtered = watchFilter ? rows.filter((r) => r.watchId === watchFilter) : rows;

console.table(
  filtered.map((r) => ({
    id: r.id.slice(0, 8),
    watch: r.watchId.slice(0, 8),
    asset: r.asset,
    tf: r.timeframe,
    status: r.status,
    score: r.currentScore,
    age: `${((Date.now() - r.createdAt.getTime()) / 3_600_000).toFixed(1)}h`,
  })),
);

await pool.end();
