import { watchConfigRevisions, watchConfigs } from "@adapters/persistence/schema";
import { ConflictError } from "@client/api/safeHandler";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

export type WatchConfigHooks = {
  bootstrap: (watch: WatchConfig) => Promise<void>;
  applyReload: (watch: WatchConfig, previous: WatchConfig | null) => Promise<void>;
  tearDown: (watchId: string) => Promise<void>;
};

export type SavedRow = { id: string; enabled: boolean; version: number };

export async function createWatchConfig(input: {
  db: DB;
  hooks: WatchConfigHooks;
  input: WatchConfig;
}): Promise<SavedRow> {
  const { db, hooks } = input;
  const watch = input.input;

  const [existing] = await db.select().from(watchConfigs).where(eq(watchConfigs.id, watch.id));
  if (existing && !existing.deletedAt) {
    throw new ConflictError(`watch ${watch.id} already exists`);
  }

  await db.transaction(async (tx) => {
    if (existing?.deletedAt) {
      await tx
        .update(watchConfigs)
        .set({
          config: watch as unknown,
          enabled: watch.enabled,
          version: 1,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(watchConfigs.id, watch.id));
    } else {
      await tx.insert(watchConfigs).values({
        id: watch.id,
        enabled: watch.enabled,
        config: watch as unknown,
        version: 1,
      });
    }
    await tx.insert(watchConfigRevisions).values({
      watchId: watch.id,
      config: watch as unknown,
      version: 1,
      appliedBy: "ui",
    });
  });

  await hooks.bootstrap(watch);
  return { id: watch.id, enabled: watch.enabled, version: 1 };
}

export async function updateWatchConfig(input: {
  db: DB;
  hooks: WatchConfigHooks;
  id: string;
  input: WatchConfig;
  expectedVersion: number;
}): Promise<SavedRow> {
  const { db, hooks, id, expectedVersion } = input;
  const next = input.input;

  const result = await db.transaction(async (tx) => {
    const [previous] = await tx.select().from(watchConfigs).where(eq(watchConfigs.id, id));
    if (!previous || previous.deletedAt) {
      throw new ConflictError(`watch ${id} not found`);
    }

    const updated = await tx
      .update(watchConfigs)
      .set({
        config: next as unknown,
        enabled: next.enabled,
        version: sql`${watchConfigs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(watchConfigs.id, id), eq(watchConfigs.version, expectedVersion)))
      .returning();

    const current = updated[0];
    if (!current) {
      throw new ConflictError(
        `version mismatch — current=${previous.version}, expected=${expectedVersion}. Reload and retry.`,
      );
    }

    await tx.insert(watchConfigRevisions).values({
      watchId: id,
      config: next as unknown,
      version: current.version,
      appliedBy: "ui",
    });

    return { previous: previous.config as WatchConfig, current };
  });

  await hooks.applyReload(next, result.previous);
  return { id, enabled: next.enabled, version: result.current.version };
}

export async function softDeleteWatchConfig(input: {
  db: DB;
  hooks: WatchConfigHooks;
  id: string;
}): Promise<void> {
  const { db, hooks, id } = input;
  await db
    .update(watchConfigs)
    .set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() })
    .where(eq(watchConfigs.id, id));
  await hooks.tearDown(id);
}
