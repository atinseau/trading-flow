import { startTestPostgres } from "@test-helpers/postgres";
import { watchConfigs, watchConfigRevisions } from "@adapters/persistence/schema";
import { seedWatchesFromYaml } from "@cli/seedWatchesFromYaml.lib";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";

const yaml = `
version: 1
market_data: [binance]
llm_providers:
  claude_max:
    type: claude-agent-sdk
    fallback: null
artifacts:
  type: filesystem
watches:
  - id: btc-1h
    enabled: true
    asset: { symbol: BTCUSDT, source: binance }
    timeframes: { primary: 1h, higher: [4h] }
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
      feedback:  { provider: claude_max, model: claude-opus-4-7 }
    notify_on: [confirmed]
`;

describe("seedWatchesFromYaml", () => {
  test("seeds new watches and skips existing ones (idempotent)", async () => {
    const tp = await startTestPostgres();
    try {
      const inserted1 = await seedWatchesFromYaml({ pool: tp.pool, yamlText: yaml });
      expect(inserted1).toBe(1);

      const inserted2 = await seedWatchesFromYaml({ pool: tp.pool, yamlText: yaml });
      expect(inserted2).toBe(0); // idempotent

      const rows = await tp.db.select().from(watchConfigs);
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe("btc-1h");

      const revs = await tp.db
        .select()
        .from(watchConfigRevisions)
        .where(eq(watchConfigRevisions.watchId, "btc-1h"));
      expect(revs.length).toBe(1);
      expect(revs[0]!.appliedBy).toBe("seed");
    } finally {
      await tp.cleanup();
    }
  });

  test("returns 0 when yaml has no watches array", async () => {
    const tp = await startTestPostgres();
    try {
      const minimal = `
version: 1
market_data: [binance]
llm_providers: {}
artifacts: { type: filesystem }
`;
      const inserted = await seedWatchesFromYaml({ pool: tp.pool, yamlText: minimal });
      expect(inserted).toBe(0);
    } finally {
      await tp.cleanup();
    }
  });
});
