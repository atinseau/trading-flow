import { events, setups, tickSnapshots } from "@adapters/persistence/schema";
import { NotFoundError, safeHandler } from "@client/api/safeHandler";
import { streamArtifact } from "@client/lib/artifacts";
import { and, asc, desc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

export function makeSetupsApi(deps: { db: DB }) {
  const { db } = deps;
  return {
    list: safeHandler(async (req) => {
      const url = new URL(req.url);
      const watchId = url.searchParams.get("watchId");
      const status = url.searchParams.get("status");
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200));

      const filters = [];
      if (watchId) filters.push(eq(setups.watchId, watchId));
      if (status) filters.push(eq(setups.status, status));

      const rows = await db
        .select()
        .from(setups)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(setups.updatedAt))
        .limit(limit);
      return Response.json(rows);
    }),

    get: safeHandler(async (_req, params) => {
      const id = params!.id!;
      const [row] = await db.select().from(setups).where(eq(setups.id, id));
      if (!row) throw new NotFoundError(`setup ${id} not found`);
      return Response.json(row);
    }),

    events: safeHandler(async (_req, params) => {
      const id = params!.id!;
      const rows = await db
        .select()
        .from(events)
        .where(eq(events.setupId, id))
        .orderBy(asc(events.sequence));
      return Response.json(rows);
    }),

    ohlcv: safeHandler(async (_req, params) => {
      const id = params!.id!;
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
