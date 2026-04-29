import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchConfigs } from "@adapters/persistence/schema";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
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
      expect(watches[0]!.id).toBe("btc-1h");
      // Schema-applied defaults should be present (verifies parsing happened)
      expect(watches[0]!.include_chart_image).toBe(true);
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

  test("logs a warning and skips malformed rows (no throw)", async () => {
    const tp = await startTestPostgres();
    try {
      // Seed: one valid + one broken
      await tp.db.insert(watchConfigs).values([
        {
          id: "valid-row",
          enabled: true,
          config: { ...FULL_WATCH, id: "valid-row" } as unknown,
          version: 1,
        },
        {
          id: "broken-row",
          enabled: true,
          config: { id: "broken-row" } as unknown, // missing required fields
          version: 1,
        },
      ]);
      const watches = await loadWatchesFromDb(tp.pool);
      expect(watches.map((w) => w.id)).toEqual(["valid-row"]);
    } finally {
      await tp.cleanup();
    }
  });
});

describe("loadWatchesConfig with DB-sourced watches", () => {
  test("when pool is provided, watches[] comes from DB and yaml watches are ignored", async () => {
    const tp = await startTestPostgres();
    try {
      // Seed DB with one watch
      await tp.db.insert(watchConfigs).values({
        id: "btc-1h",
        enabled: true,
        config: FULL_WATCH as unknown,
        version: 1,
      });

      // Yaml contains a different watch — should be ignored
      const dir = mkdtempSync(join(tmpdir(), "watches-yaml-"));
      const yamlPath = join(dir, "watches.yaml");
      writeFileSync(
        yamlPath,
        `version: 1
market_data: [binance]
llm_providers:
  claude_max:
    type: claude-agent-sdk
    fallback: null
artifacts:
  type: filesystem
watches:
  - id: ignored-yaml-watch
    enabled: true
    asset: { symbol: ETHUSDT, source: binance }
    timeframes: { primary: 4h, higher: [] }
    schedule: { timezone: UTC }
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 }
    setup_lifecycle:
      ttl_candles: 50
      score_initial: 25
      score_threshold_finalizer: 80
      score_threshold_dead: 10
    analyzers:
      detector:  { provider: claude_max, model: claude-sonnet-4-6 }
      reviewer:  { provider: claude_max, model: claude-haiku-4-5 }
      finalizer: { provider: claude_max, model: claude-opus-4-7 }
    notify_on: [confirmed]
`,
      );

      const cfg = await loadWatchesConfig(yamlPath, { pool: tp.pool });
      expect(cfg).not.toBeNull();
      expect(cfg!.watches.length).toBe(1);
      expect(cfg!.watches[0]!.id).toBe("btc-1h");
    } finally {
      await tp.cleanup();
    }
  });

  test("when pool is omitted, watches[] still comes from yaml (back-compat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watches-yaml-"));
    const yamlPath = join(dir, "watches.yaml");
    writeFileSync(
      yamlPath,
      `version: 1
market_data: [binance]
llm_providers:
  claude_max:
    type: claude-agent-sdk
    fallback: null
artifacts:
  type: filesystem
watches: []
`,
    );

    const cfg = await loadWatchesConfig(yamlPath);
    expect(cfg).not.toBeNull();
    expect(cfg!.watches).toEqual([]);
  });
});
