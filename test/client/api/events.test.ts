import { describe, expect, test } from "bun:test";
import { events, setups } from "@adapters/persistence/schema";
import { makeEventsApi } from "@client/api/events";
import { startTestPostgres } from "@test-helpers/postgres";

describe("events API", () => {
  test("GET /api/events paginates with ?since cursor", async () => {
    const tp = await startTestPostgres();
    try {
      const setupId = crypto.randomUUID();
      await tp.db.insert(setups).values({
        id: setupId,
        watchId: "btc-1h",
        asset: "BTCUSDT",
        timeframe: "1h",
        status: "REVIEWING",
        currentScore: "0",
        ttlCandles: 50,
        ttlExpiresAt: new Date(Date.now() + 1e9),
        workflowId: "wf-1",
      });

      for (let i = 1; i <= 5; i++) {
        await tp.db.insert(events).values({
          setupId,
          sequence: i,
          stage: "REVIEWER",
          actor: "x",
          type: "Strengthened",
          scoreAfter: String(20 + i * 5),
          statusBefore: "REVIEWING",
          statusAfter: "REVIEWING",
          payload: {} as never,
        });
        // small delay so occurredAt differs
        await new Promise((r) => setTimeout(r, 5));
      }

      const api = makeEventsApi({ db: tp.db });
      const all = await api.list(new Request("http://x/api/events?limit=3"));
      const items = (await all.json()) as { id: string; occurredAt: string }[];
      expect(items.length).toBe(3);

      const cursor = items[items.length - 1]!.occurredAt;
      const next = await api.list(
        new Request(`http://x/api/events?limit=3&since=${encodeURIComponent(cursor)}`),
      );
      const more = (await next.json()) as unknown[];
      expect(more.length).toBe(2);
    } finally {
      await tp.cleanup();
    }
  });
});
