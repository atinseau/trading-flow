import { llmCalls } from "@adapters/persistence/schema";
import { getLogger } from "@observability/logger";
import { and, eq, gte, sql } from "drizzle-orm";
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

// Source of truth = `llm_calls` (every LLM invocation). The legacy aggregation
// joined `events` to `setups` and silently dropped detector ticks that didn't
// produce a setup. The /api/costs endpoint also reads from llm_calls — both
// CLI and UI now agree.
const groupColumn =
  byFilter === "model"
    ? llmCalls.model
    : byFilter === "stage"
      ? llmCalls.stage
      : byFilter === "day"
        ? sql<string>`DATE_TRUNC('day', ${llmCalls.occurredAt})::text`
        : byFilter === "watch"
          ? sql<string>`coalesce(${llmCalls.watchId}, '(no-watch)')`
          : llmCalls.provider;

const wheres = [];
if (sinceFilter) wheres.push(gte(llmCalls.occurredAt, new Date(sinceFilter)));
if (watchFilter) wheres.push(eq(llmCalls.watchId, watchFilter));

const rows = await db
  .select({
    group: groupColumn,
    callCount: sql<number>`COUNT(*)::int`,
    totalCostUsd: sql<string>`COALESCE(SUM(${llmCalls.costUsd}), 0)::text`,
  })
  .from(llmCalls)
  .where(wheres.length ? and(...wheres) : undefined)
  .groupBy(groupColumn);

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
