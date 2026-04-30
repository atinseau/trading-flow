import { events, setups } from "@adapters/persistence/schema";
import { ValidationError, safeHandler } from "@client/api/safeHandler";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

const VALID_GROUPS = ["watch", "provider", "model", "day"] as const;
type GroupBy = (typeof VALID_GROUPS)[number];

export function makeCostsApi(deps: { db: DB }) {
  return {
    aggregations: safeHandler(async (req) => {
      const url = new URL(req.url);
      const groupBy = (url.searchParams.get("groupBy") ?? "watch") as GroupBy;
      if (!VALID_GROUPS.includes(groupBy)) {
        throw new ValidationError(`groupBy must be one of: ${VALID_GROUPS.join(", ")}`);
      }
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");

      const filters = [] as ReturnType<typeof eq>[];
      if (from) filters.push(gte(events.occurredAt, new Date(from)));
      if (to) filters.push(lte(events.occurredAt, new Date(to)));

      const keyExpr = (() => {
        switch (groupBy) {
          case "watch":
            return setups.watchId;
          case "provider":
            return events.provider;
          case "model":
            return events.model;
          case "day":
            return sql<string>`to_char(${events.occurredAt}, 'YYYY-MM-DD')`;
        }
      })();

      const rows = await deps.db
        .select({
          key: keyExpr,
          totalUsd: sql<string>`coalesce(sum(${events.costUsd}), 0)`,
          count: sql<string>`count(*)`,
        })
        .from(events)
        .innerJoin(setups, eq(events.setupId, setups.id))
        .where(filters.length ? and(...filters) : undefined)
        .groupBy(keyExpr);

      return Response.json(
        rows.map((r) => ({
          key: r.key,
          totalUsd: Number(r.totalUsd),
          count: Number(r.count),
        })),
      );
    }),
  };
}
