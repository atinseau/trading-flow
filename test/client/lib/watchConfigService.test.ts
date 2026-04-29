import { watchConfigRevisions, watchConfigs } from "@adapters/persistence/schema";
import { ConflictError } from "@client/api/safeHandler";
import {
  createWatchConfig,
  softDeleteWatchConfig,
  updateWatchConfig,
} from "@client/lib/watchConfigService";
import { type WatchConfig, WatchSchema } from "@domain/schemas/WatchesConfig";
import { startTestPostgres } from "@test-helpers/postgres";
import { describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

const fullWatch = (id = "btc-1h"): WatchConfig =>
  WatchSchema.parse({
    id,
    enabled: true,
    asset: { symbol: "BTCUSDT", source: "binance" },
    timeframes: { primary: "1h", higher: ["4h"] },
    schedule: { timezone: "UTC" },
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
    setup_lifecycle: {
      ttl_candles: 50,
      score_initial: 25,
      score_threshold_finalizer: 80,
      score_threshold_dead: 10,
      invalidation_policy: "strict",
    },
    analyzers: {
      detector: { provider: "claude_max", model: "claude-sonnet-4-6" },
      reviewer: { provider: "claude_max", model: "claude-haiku-4-5" },
      finalizer: { provider: "claude_max", model: "claude-opus-4-7" },
    },
    notify_on: ["confirmed"],
  });

const noopHooks = () => ({
  bootstrap: mock(async () => undefined),
  applyReload: mock(async () => undefined),
  tearDown: mock(async () => undefined),
});

describe("watchConfigService", () => {
  test("create inserts config + revision and calls bootstrap", async () => {
    const tp = await startTestPostgres();
    try {
      const watch = fullWatch();
      const hooks = noopHooks();
      const created = await createWatchConfig({ db: tp.db, hooks, input: watch });
      expect(created.id).toBe("btc-1h");
      expect(created.version).toBe(1);
      const revs = await tp.db.select().from(watchConfigRevisions);
      expect(revs.length).toBe(1);
      expect(hooks.bootstrap).toHaveBeenCalledTimes(1);
    } finally {
      await tp.cleanup();
    }
  });

  test("create rejects duplicate id with ConflictError", async () => {
    const tp = await startTestPostgres();
    try {
      const w = fullWatch();
      const hooks = noopHooks();
      await createWatchConfig({ db: tp.db, hooks, input: w });
      await expect(createWatchConfig({ db: tp.db, hooks, input: w })).rejects.toThrow(
        ConflictError,
      );
    } finally {
      await tp.cleanup();
    }
  });

  test("create revives a soft-deleted row at version 1", async () => {
    const tp = await startTestPostgres();
    try {
      const w = fullWatch();
      const hooks = noopHooks();
      await createWatchConfig({ db: tp.db, hooks, input: w });
      await softDeleteWatchConfig({ db: tp.db, hooks, id: w.id });
      const created = await createWatchConfig({ db: tp.db, hooks, input: w });
      expect(created.version).toBe(1);
      const [row] = await tp.db.select().from(watchConfigs).where(eq(watchConfigs.id, w.id));
      expect(row?.deletedAt).toBeNull();
    } finally {
      await tp.cleanup();
    }
  });

  test("update bumps version when expectedVersion matches", async () => {
    const tp = await startTestPostgres();
    try {
      const w = fullWatch();
      const hooks = noopHooks();
      await createWatchConfig({ db: tp.db, hooks, input: w });
      const next = { ...w, enabled: false };
      const updated = await updateWatchConfig({
        db: tp.db,
        hooks,
        id: w.id,
        input: next,
        expectedVersion: 1,
      });
      expect(updated.version).toBe(2);
      expect(hooks.applyReload).toHaveBeenCalledTimes(1);
    } finally {
      await tp.cleanup();
    }
  });

  test("update fails 409 on stale version", async () => {
    const tp = await startTestPostgres();
    try {
      const w = fullWatch();
      const hooks = noopHooks();
      await createWatchConfig({ db: tp.db, hooks, input: w });
      await expect(
        updateWatchConfig({ db: tp.db, hooks, id: w.id, input: w, expectedVersion: 99 }),
      ).rejects.toThrow(ConflictError);
    } finally {
      await tp.cleanup();
    }
  });

  test("softDelete sets deletedAt and calls tearDown", async () => {
    const tp = await startTestPostgres();
    try {
      const w = fullWatch();
      const hooks = noopHooks();
      await createWatchConfig({ db: tp.db, hooks, input: w });
      await softDeleteWatchConfig({ db: tp.db, hooks, id: w.id });
      const [row] = await tp.db.select().from(watchConfigs).where(eq(watchConfigs.id, w.id));
      expect(row?.deletedAt).not.toBeNull();
      expect(hooks.tearDown).toHaveBeenCalledTimes(1);
    } finally {
      await tp.cleanup();
    }
  });
});
