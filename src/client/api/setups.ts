import { events, llmCalls, setups, tickSnapshots } from "@adapters/persistence/schema";
import { NotFoundError, requireParam, safeHandler } from "@client/api/safeHandler";
import { streamArtifact } from "@client/lib/artifacts";
import { TERMINAL_STATUSES } from "@domain/state-machine/setupTransitions";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

// "Live" in the dashboard sense = "any non-terminal status" (includes
// CANDIDATE, which the domain's ACTIVE_STATUSES excludes for workflow
// transition reasons we don't want to touch). Single source of truth via
// TERMINAL_STATUSES — invert it.
const TERMINAL = [...TERMINAL_STATUSES];
const WIN_OUTCOMES = ["WIN", "PARTIAL_WIN"] as const;
const OTHER_OUTCOMES = [
  "TIME_OUT",
  "REJECTED",
  "INVALIDATED_PRE_TRADE",
  "INVALIDATED_POST_TRADE",
  "EXPIRED_NO_FILL",
] as const;

export function makeSetupsApi(deps: { db: DB }) {
  const { db } = deps;
  return {
    list: safeHandler(async (req) => {
      const url = new URL(req.url);
      const watchId = url.searchParams.get("watchId");
      const status = url.searchParams.get("status");
      const outcome = url.searchParams.get("outcome");
      const category = url.searchParams.get("category");
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200));

      const filters = [];
      if (watchId) filters.push(eq(setups.watchId, watchId));
      if (status) filters.push(eq(setups.status, status));
      if (outcome) filters.push(eq(setups.outcome, outcome));

      if (category === "live") {
        filters.push(notInArray(setups.status, TERMINAL));
      } else if (category === "wins") {
        filters.push(inArray(setups.outcome, [...WIN_OUTCOMES]));
      } else if (category === "losses") {
        filters.push(eq(setups.outcome, "LOSS"));
      } else if (category === "other") {
        filters.push(inArray(setups.outcome, [...OTHER_OUTCOMES]));
      }

      const rows = await db
        .select()
        .from(setups)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(setups.updatedAt))
        .limit(limit);
      return Response.json(rows);
    }),

    stats: safeHandler(async (req) => {
      const url = new URL(req.url);
      const watchId = url.searchParams.get("watchId");
      const watchFilter = watchId ? eq(setups.watchId, watchId) : undefined;

      // Aggregate counts in a single query: total, live, wins, losses, other.
      // The `live` filter uses TERMINAL_STATUSES inverted via sql.raw — same
      // single source of truth as the list endpoint.
      const terminalSqlList = sql.raw(`(${[...TERMINAL_STATUSES].map((s) => `'${s}'`).join(",")})`);
      const [agg] = await db
        .select({
          total: sql<number>`count(*)::int`,
          live: sql<number>`count(*) filter (where ${setups.status} not in ${terminalSqlList})::int`,
          wins: sql<number>`count(*) filter (where ${setups.outcome} in ('WIN','PARTIAL_WIN'))::int`,
          losses: sql<number>`count(*) filter (where ${setups.outcome} = 'LOSS')::int`,
          other: sql<number>`count(*) filter (where ${setups.outcome} in ('TIME_OUT','REJECTED','INVALIDATED_PRE_TRADE','INVALIDATED_POST_TRADE','EXPIRED_NO_FILL'))::int`,
        })
        .from(setups)
        .where(watchFilter);

      const wins = agg?.wins ?? 0;
      const losses = agg?.losses ?? 0;
      const winRate = wins + losses > 0 ? wins / (wins + losses) : null;

      // avg score at confirmation event — read events.score_after.
      const [avgRow] = await db
        .select({
          avg: sql<string | null>`avg(${events.scoreAfter}::numeric)`,
        })
        .from(events)
        .innerJoin(setups, eq(events.setupId, setups.id))
        .where(
          and(eq(events.type, "Confirmed"), watchId ? eq(setups.watchId, watchId) : undefined),
        );
      const avgScoreAtConfirmation =
        avgRow?.avg !== null && avgRow?.avg !== undefined ? Number(avgRow.avg) : null;

      // Cost source = llm_calls (every LLM invocation). Filtering by watchId
      // here covers detector ticks even when they didn't produce a setup —
      // the previous events-based join silently zeroed those out.
      const [costRow] = await db
        .select({
          total: sql<string | null>`coalesce(sum(${llmCalls.costUsd}::numeric), 0)`,
        })
        .from(llmCalls)
        .where(watchId ? eq(llmCalls.watchId, watchId) : undefined);
      const totalCostUsd = Number(costRow?.total ?? 0);

      return Response.json({
        total: agg?.total ?? 0,
        live: agg?.live ?? 0,
        wins,
        losses,
        other: agg?.other ?? 0,
        winRate,
        avgScoreAtConfirmation,
        totalCostUsd,
      });
    }),

    get: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const [row] = await db.select().from(setups).where(eq(setups.id, id));
      if (!row) throw new NotFoundError(`setup ${id} not found`);
      return Response.json(row);
    }),

    events: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const rows = await db
        .select()
        .from(events)
        .where(eq(events.setupId, id))
        .orderBy(asc(events.sequence));
      return Response.json(rows);
    }),

    ohlcv: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const [setup] = await db.select().from(setups).where(eq(setups.id, id));
      if (!setup) throw new NotFoundError(`setup ${id} not found`);

      const [tick] = await db
        .select()
        .from(tickSnapshots)
        .where(eq(tickSnapshots.watchId, setup.watchId))
        .orderBy(desc(tickSnapshots.tickAt))
        .limit(1);
      if (!tick) throw new NotFoundError(`no tickSnapshot for watch ${setup.watchId}`);

      const baseDir = process.env.ARTIFACTS_BASE_DIR ?? "/data/artifacts";
      return streamArtifact({ uri: tick.ohlcvUri, baseDir });
    }),
  };
}
