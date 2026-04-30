import { tickSnapshots } from "@adapters/persistence/schema";
import { NotFoundError, requireParam, safeHandler } from "@client/api/safeHandler";
import { streamArtifact } from "@client/lib/artifacts";
import { desc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

export function makeTicksApi(deps: { db: DB }) {
  return {
    list: safeHandler(async (req) => {
      const url = new URL(req.url);
      const watchId = url.searchParams.get("watchId");
      if (!watchId) return Response.json({ error: "watchId required" }, { status: 400 });
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));

      const rows = await deps.db
        .select()
        .from(tickSnapshots)
        .where(eq(tickSnapshots.watchId, watchId))
        .orderBy(desc(tickSnapshots.tickAt))
        .limit(limit);
      return Response.json(rows);
    }),

    chartPng: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const [tick] = await deps.db.select().from(tickSnapshots).where(eq(tickSnapshots.id, id));
      if (!tick) throw new NotFoundError(`tick ${id} not found`);
      const baseDir = process.env.ARTIFACTS_BASE_DIR ?? "/data/artifacts";
      return streamArtifact({ uri: tick.chartUri, baseDir });
    }),
  };
}
