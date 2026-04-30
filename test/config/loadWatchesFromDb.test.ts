import { describe, expect, test } from "bun:test";
import { watchConfigs } from "@adapters/persistence/schema";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { startTestPostgres } from "@test-helpers/postgres";

const FULL_WATCH = {
  id: "btc-1h",
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
    feedback: { provider: "claude_max", model: "claude-opus-4-7" },
  },
  notify_on: ["confirmed", "tp_hit", "sl_hit"],
};

describe("loadWatchesFromDb", () => {
  test("returns parsed watches, ignoring soft-deleted ones", async () => {
    const tp = await startTestPostgres();
    try {
      await tp.db.insert(watchConfigs).values([
        { id: "btc-1h", enabled: true, config: FULL_WATCH as unknown, version: 1 },
        {
          id: "old",
          enabled: false,
          config: { ...FULL_WATCH, id: "old" } as unknown,
          version: 1,
          deletedAt: new Date(),
        },
      ]);
      const watches: WatchConfig[] = await loadWatchesFromDb(tp.pool);
      expect(watches.length).toBe(1);
      expect(watches[0]?.id).toBe("btc-1h");
      // Schema-applied defaults should be present (verifies parsing happened)
      expect(watches[0]?.include_chart_image).toBe(true);
    } finally {
      await tp.cleanup();
    }
  });

  test("returns empty array when no rows", async () => {
    const tp = await startTestPostgres();
    try {
      const watches = await loadWatchesFromDb(tp.pool);
      expect(watches).toEqual([]);
    } finally {
      await tp.cleanup();
    }
  });

  test("throws WatchesConfigError with row id when config jsonb is malformed", async () => {
    const tp = await startTestPostgres();
    try {
      await tp.db.insert(watchConfigs).values({
        id: "broken-row",
        enabled: true,
        // Intentionally invalid: missing required fields
        config: { id: "broken-row" } as unknown,
        version: 1,
      });

      await expect(loadWatchesFromDb(tp.pool)).rejects.toThrow(/broken-row/);
    } finally {
      await tp.cleanup();
    }
  });
});
