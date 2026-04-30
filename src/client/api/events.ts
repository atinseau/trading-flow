import { events, setups } from "@adapters/persistence/schema";
import { safeHandler } from "@client/api/safeHandler";
import { and, asc, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

export function makeEventsApi(deps: { db: DB }) {
  return {
    list: safeHandler(async (req) => {
      const url = new URL(req.url);
      const since = url.searchParams.get("since");
      const watchId = url.searchParams.get("watchId");
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));

      const filters = [] as ReturnType<typeof eq>[];
      // Compare at ms precision: pg's `Date` parsing truncates μs to ms, so the
      // cursor returned to the client is ms-precision. Truncate the column too so
      // the boundary record isn't included on the next page.
      if (since)
        filters.push(
          sql`date_trunc('milliseconds', ${events.occurredAt}) > ${new Date(since)}` as unknown as ReturnType<
            typeof eq
          >,
        );
      if (watchId) filters.push(eq(setups.watchId, watchId));

      const rows = await deps.db
        .select({
          id: events.id,
          setupId: events.setupId,
          sequence: events.sequence,
          occurredAt: events.occurredAt,
          type: events.type,
          scoreDelta: events.scoreDelta,
          scoreAfter: events.scoreAfter,
          statusBefore: events.statusBefore,
          statusAfter: events.statusAfter,
          payload: events.payload,
          provider: events.provider,
          model: events.model,
          costUsd: events.costUsd,
          latencyMs: events.latencyMs,
          watchId: setups.watchId,
        })
        .from(events)
        .innerJoin(setups, eq(events.setupId, setups.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(asc(events.occurredAt), asc(events.id))
        .limit(limit);

      return Response.json(rows);
    }),
  };
}
