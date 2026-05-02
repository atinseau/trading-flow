import {
  llmCalls,
  watchConfigRevisions,
  watchConfigs,
  watchStates,
} from "@adapters/persistence/schema";
import { NotFoundError, requireParam, safeHandler } from "@client/api/safeHandler";
import {
  createWatchConfig,
  softDeleteWatchConfig,
  updateWatchConfig,
  type WatchConfigHooks,
} from "@client/lib/watchConfigService";
import { lookupYahooMetadata } from "@client/lib/yahooMetadata";
import { WatchSchema } from "@domain/schemas/WatchesConfig";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
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

      // Cost source-of-truth = llm_calls. The state.totalCostUsd* columns are
      // legacy (only updated by recordWatchTick which itself is being phased
      // out); they can drift from llm_calls. Override the response fields so
      // the UI sees consistent numbers across pages.
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [costAggMtd] = await db
        .select({
          total: sql<string | null>`coalesce(sum(${llmCalls.costUsd}::numeric), 0)`,
        })
        .from(llmCalls)
        .where(and(eq(llmCalls.watchId, id), gte(llmCalls.occurredAt, monthStart)));
      const [costAggAll] = await db
        .select({
          total: sql<string | null>`coalesce(sum(${llmCalls.costUsd}::numeric), 0)`,
        })
        .from(llmCalls)
        .where(eq(llmCalls.watchId, id));

      // Parse the stored config through WatchSchema so Zod prefaults populate
      // any fields added after this watch was originally saved (e.g. new
      // `costs` block, `optimization.allow_same_tick_fast_path`,
      // `setup_lifecycle.min_risk_reward_ratio`). Without this, the form
      // shows empty inputs for newly added fields. Falls back to raw config
      // if the stored shape doesn't validate (legacy invalid rows).
      const parsedConfig = WatchSchema.safeParse(row.config);
      const responseConfig = parsedConfig.success ? parsedConfig.data : row.config;

      return Response.json({
        id: row.id,
        enabled: row.enabled,
        version: row.version,
        config: responseConfig,
        state: state
          ? {
              ...state,
              totalCostUsdMtd: String(costAggMtd?.total ?? "0"),
              totalCostUsdAllTime: String(costAggAll?.total ?? "0"),
            }
          : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }),

    create: safeHandler(async (req) => {
      // biome-ignore lint/suspicious/noExplicitAny: raw body before validation
      const raw = (await req.json()) as any;
      // Server-side enrichment: yahoo watches without quoteType get a Yahoo lookup.
      // Mirrors GET /api/yahoo/lookup for non-wizard API clients (cron, scripts).
      if (raw?.asset?.source === "yahoo" && !raw.asset.quoteType) {
        const symbol = String(raw.asset.symbol);
        const meta = await lookupYahooMetadata(symbol);
        if (!meta) throw new NotFoundError(`yahoo asset not found: ${symbol}`);
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
