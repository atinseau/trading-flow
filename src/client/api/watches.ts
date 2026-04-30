import { watchConfigRevisions, watchConfigs, watchStates } from "@adapters/persistence/schema";
import { NotFoundError, requireParam, safeHandler } from "@client/api/safeHandler";
import {
  createWatchConfig,
  softDeleteWatchConfig,
  updateWatchConfig,
  type WatchConfigHooks,
} from "@client/lib/watchConfigService";
import { lookupYahooMetadata } from "@client/lib/yahooMetadata";
import { WatchSchema } from "@domain/schemas/WatchesConfig";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

type DB = ReturnType<typeof drizzle>;

const UpdateBodySchema = z.object({
  config: WatchSchema,
  version: z.number().int().nonnegative(),
});

export function makeWatchesApi(deps: { db: DB; hooks: WatchConfigHooks }) {
  const { db, hooks } = deps;

  return {
    list: safeHandler(async () => {
      const rows = await db
        .select({
          id: watchConfigs.id,
          enabled: watchConfigs.enabled,
          version: watchConfigs.version,
          config: watchConfigs.config,
          createdAt: watchConfigs.createdAt,
          updatedAt: watchConfigs.updatedAt,
        })
        .from(watchConfigs)
        .where(isNull(watchConfigs.deletedAt));
      return Response.json(rows);
    }),

    get: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const [row] = await db
        .select()
        .from(watchConfigs)
        .where(and(eq(watchConfigs.id, id), isNull(watchConfigs.deletedAt)));
      if (!row) throw new NotFoundError(`watch ${id} not found`);
      const [state] = await db.select().from(watchStates).where(eq(watchStates.watchId, id));
      return Response.json({
        id: row.id,
        enabled: row.enabled,
        version: row.version,
        config: row.config,
        state: state ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }),

    create: safeHandler(async (req) => {
      // biome-ignore lint/suspicious/noExplicitAny: raw body before validation
      const raw = (await req.json()) as any;
      // Server-side enrichment: yahoo watches without quoteType get a Yahoo lookup.
      if (raw?.asset?.source === "yahoo" && !raw.asset.quoteType) {
        const meta = await lookupYahooMetadata(String(raw.asset.symbol));
        if (!meta) {
          return Response.json(
            { error: `Asset '${raw.asset.symbol}' not found on Yahoo` },
            { status: 422 },
          );
        }
        raw.asset.quoteType = meta.quoteType;
        if (meta.exchange) raw.asset.exchange = meta.exchange;
      }
      const body = WatchSchema.parse(raw);
      const created = await createWatchConfig({ db, hooks, input: body });
      return Response.json(created, { status: 201 });
    }),

    update: safeHandler(async (req, params) => {
      const id = requireParam(params, "id");
      const body = UpdateBodySchema.parse(await req.json());
      if (body.config.id !== id) {
        return Response.json({ error: "config.id must match URL param" }, { status: 400 });
      }
      const updated = await updateWatchConfig({
        db,
        hooks,
        id,
        input: body.config,
        expectedVersion: body.version,
      });
      return Response.json(updated);
    }),

    del: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const [row] = await db.select().from(watchConfigs).where(eq(watchConfigs.id, id));
      if (!row || row.deletedAt) throw new NotFoundError(`watch ${id} not found`);
      await softDeleteWatchConfig({ db, hooks, id });
      return new Response(null, { status: 204 });
    }),

    revisions: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const rows = await db
        .select()
        .from(watchConfigRevisions)
        .where(eq(watchConfigRevisions.watchId, id))
        .orderBy(desc(watchConfigRevisions.appliedAt));
      return Response.json(rows);
    }),
  };
}
