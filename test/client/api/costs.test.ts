import { describe, expect, test } from "bun:test";
import { llmCalls } from "@adapters/persistence/schema";
import { makeCostsApi } from "@client/api/costs";
import { startTestPostgres } from "@test-helpers/postgres";

describe("costs API", () => {
  test("aggregates totals by watch", async () => {
    const tp = await startTestPostgres();
    try {
      await tp.db.insert(llmCalls).values([
        {
          watchId: "btc-1h",
          stage: "DETECTOR",
          provider: "claude_max",
          model: "sonnet",
          costUsd: "0.05",
          occurredAt: new Date(),
        },
        {
          watchId: "btc-1h",
          stage: "REVIEWER",
          provider: "claude_max",
          model: "haiku",
          costUsd: "0.02",
          occurredAt: new Date(),
        },
        {
          watchId: "eth-4h",
          stage: "DETECTOR",
          provider: "openrouter",
          model: "haiku",
          costUsd: "0.04",
          occurredAt: new Date(),
        },
      ]);

      const api = makeCostsApi({ db: tp.db });
      const res = await api.aggregations(new Request("http://x/api/costs?groupBy=watch"));
      const items = (await res.json()) as { key: string; totalUsd: number }[];
      const btc = items.find((i) => i.key === "btc-1h");
      const eth = items.find((i) => i.key === "eth-4h");
      expect(btc?.totalUsd).toBeCloseTo(0.07, 4);
      expect(eth?.totalUsd).toBeCloseTo(0.04, 4);
    } finally {
      await tp.cleanup();
    }
  });

  test("rejects invalid groupBy with 400", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeCostsApi({ db: tp.db });
      const res = await api.aggregations(new Request("http://x/api/costs?groupBy=garbage"));
      expect(res.status).toBe(400);
    } finally {
      await tp.cleanup();
    }
  });
});
