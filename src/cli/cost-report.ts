import { events, setups } from "@adapters/persistence/schema";
import { getLogger } from "@observability/logger";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const log = getLogger({ component: "cost-report-cli" });

const watchFilter = process.argv.find((a) => a.startsWith("--watch="))?.slice(8);
const sinceFilter = process.argv.find((a) => a.startsWith("--since="))?.slice(8);
const byFilter = process.argv.find((a) => a.startsWith("--by="))?.slice(5) ?? "provider";

const url = process.env.DATABASE_URL;
if (!url) {
  log.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

const groupColumn =
  byFilter === "model"
    ? events.model
    : byFilter === "stage"
      ? events.stage
      : byFilter === "day"
        ? sql<string>`DATE_TRUNC('day', ${events.occurredAt})::text`
        : events.provider;

const wheres = [isNotNull(events.costUsd)];
if (sinceFilter) wheres.push(gte(events.occurredAt, new Date(sinceFilter)));
if (watchFilter) wheres.push(eq(setups.watchId, watchFilter));

const baseQuery = watchFilter
  ? db
      .select({
        group: groupColumn,
        callCount: sql<number>`COUNT(*)::int`,
        totalCostUsd: sql<string>`COALESCE(SUM(${events.costUsd}), 0)::text`,
      })
      .from(events)
      .innerJoin(setups, eq(events.setupId, setups.id))
      .where(and(...wheres))
      .groupBy(groupColumn)
  : db
      .select({
        group: groupColumn,
        callCount: sql<number>`COUNT(*)::int`,
        totalCostUsd: sql<string>`COALESCE(SUM(${events.costUsd}), 0)::text`,
      })
      .from(events)
      .where(and(...wheres))
      .groupBy(groupColumn);

const rows = await baseQuery;

console.log(
  `\nCost report (by ${byFilter}${watchFilter ? `, watch=${watchFilter}` : ""}${sinceFilter ? `, since=${sinceFilter}` : ""}):\n`,
);

console.table(
  rows.map((r) => ({
    [byFilter]: r.group ?? "(unknown)",
    calls: r.callCount,
    cost_usd: Number(r.totalCostUsd).toFixed(4),
  })),
);

const totalCalls = rows.reduce((s, r) => s + r.callCount, 0);
const totalCost = rows.reduce((s, r) => s + Number(r.totalCostUsd), 0);
console.log(`\nTotal: ${totalCalls} calls, $${totalCost.toFixed(4)}\n`);

await pool.end();
