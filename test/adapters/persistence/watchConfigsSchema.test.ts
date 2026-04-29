import { describe, expect, test } from "bun:test";
import { watchConfigRevisions, watchConfigs } from "@adapters/persistence/schema";
import { startTestPostgres } from "@test-helpers/postgres";
import { eq } from "drizzle-orm";

describe("watch_configs schema", () => {
  test("insert + read round-trips a watch config", async () => {
    const tp = await startTestPostgres();
    try {
      await tp.db.insert(watchConfigs).values({
        id: "btc-1h",
        enabled: true,
        config: { id: "btc-1h", asset: { symbol: "BTCUSDT", source: "binance" } } as unknown,
        version: 1,
      });
      const [row] = await tp.db.select().from(watchConfigs).where(eq(watchConfigs.id, "btc-1h"));
      expect(row?.id).toBe("btc-1h");
      expect(row?.version).toBe(1);
      expect((row?.config as { id: string }).id).toBe("btc-1h");
    } finally {
      await tp.cleanup();
    }
  });

  test("revisions cascade on watch_configs delete", async () => {
    const tp = await startTestPostgres();
    try {
      await tp.db.insert(watchConfigs).values({
        id: "eth-4h",
        enabled: true,
        config: {} as unknown,
        version: 1,
      });
      await tp.db.insert(watchConfigRevisions).values({
        watchId: "eth-4h",
        config: {} as unknown,
        version: 1,
        appliedBy: "ui",
      });
      await tp.db.delete(watchConfigs).where(eq(watchConfigs.id, "eth-4h"));
      const revs = await tp.db
        .select()
        .from(watchConfigRevisions)
        .where(eq(watchConfigRevisions.watchId, "eth-4h"));
      expect(revs.length).toBe(0);
    } finally {
      await tp.cleanup();
    }
  });
});
