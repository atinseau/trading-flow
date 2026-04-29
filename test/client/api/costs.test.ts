import { events, setups } from "@adapters/persistence/schema";
import { startTestPostgres } from "@test-helpers/postgres";
import { makeCostsApi } from "@client/api/costs";
import { describe, expect, test } from "bun:test";

describe("costs API", () => {
  test("aggregates totals by watch", async () => {
    const tp = await startTestPostgres();
    try {
      const sBtc = crypto.randomUUID();
      const sEth = crypto.randomUUID();
      await tp.db.insert(setups).values([
        {
          id: sBtc, watchId: "btc-1h", asset: "BTCUSDT", timeframe: "1h",
          status: "REVIEWING", currentScore: "0",
          ttlCandles: 50, ttlExpiresAt: new Date(Date.now() + 1e9), workflowId: "w1",
        },
        {
          id: sEth, watchId: "eth-4h", asset: "ETHUSDT", timeframe: "4h",
          status: "REVIEWING", currentScore: "0",
          ttlCandles: 50, ttlExpiresAt: new Date(Date.now() + 1e9), workflowId: "w2",
        },
      ]);
      await tp.db.insert(events).values([
        {
          setupId: sBtc, sequence: 1, stage: "DETECTOR", actor: "x",
          type: "SetupCreated", scoreAfter: "25",
          statusBefore: "PROPOSED", statusAfter: "REVIEWING",
          payload: {} as never, provider: "claude_max", model: "sonnet", costUsd: "0.05",
        },
        {
          setupId: sBtc, sequence: 2, stage: "REVIEWER", actor: "x",
          type: "Strengthened", scoreAfter: "35",
          statusBefore: "REVIEWING", statusAfter: "REVIEWING",
          payload: {} as never, provider: "claude_max", model: "haiku", costUsd: "0.02",
        },
        {
          setupId: sEth, sequence: 1, stage: "DETECTOR", actor: "x",
          type: "SetupCreated", scoreAfter: "25",
          statusBefore: "PROPOSED", statusAfter: "REVIEWING",
          payload: {} as never, provider: "openrouter", model: "haiku", costUsd: "0.04",
        },
      ]);

      const api = makeCostsApi({ db: tp.db });
      const res = await api.aggregations(new Request("http://x/api/costs?groupBy=watch"));
      const items = (await res.json()) as { key: string; totalUsd: number }[];
      const btc = items.find((i) => i.key === "btc-1h");
      const eth = items.find((i) => i.key === "eth-4h");
      expect(btc?.totalUsd).toBeCloseTo(0.07, 4);
      expect(eth?.totalUsd).toBeCloseTo(0.04, 4);
    } finally { await tp.cleanup(); }
  });

  test("rejects invalid groupBy with 400", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeCostsApi({ db: tp.db });
      const res = await api.aggregations(new Request("http://x/api/costs?groupBy=garbage"));
      expect(res.status).toBe(400);
    } finally { await tp.cleanup(); }
  });
});
