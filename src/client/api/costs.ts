import { llmCalls } from "@adapters/persistence/schema";
import { safeHandler, ValidationError } from "@client/api/safeHandler";
import { and, type eq, gte, lte, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

const VALID_GROUPS = ["watch", "provider", "model", "day", "stage"] as const;
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
      if (from) filters.push(gte(llmCalls.occurredAt, new Date(from)));
      if (to) filters.push(lte(llmCalls.occurredAt, new Date(to)));

      // Source of truth for LLM costs is `llm_calls` (every invocation,
      // setup-scoped or not). The old aggregation joined `events` against
      // `setups` and silently dropped detector ticks that didn't produce a
      // setup — i.e. the steady-state common case for an idle market.
      const keyExpr = (() => {
        switch (groupBy) {
          case "watch":
            return sql<string>`coalesce(${llmCalls.watchId}, '(no-watch)')`;
          case "provider":
            return llmCalls.provider;
          case "model":
            return llmCalls.model;
          case "stage":
            return llmCalls.stage;
          case "day":
            return sql<string>`to_char(${llmCalls.occurredAt}, 'YYYY-MM-DD')`;
        }
      })();

      const rows = await deps.db
        .select({
          key: keyExpr,
          totalUsd: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)`,
          count: sql<string>`count(*)`,
        })
        .from(llmCalls)
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
