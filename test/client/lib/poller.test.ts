import { events, setups } from "@adapters/persistence/schema";
import { Broadcaster } from "@client/lib/broadcaster";
import { startPoller } from "@client/lib/poller";
import { startTestPostgres } from "@test-helpers/postgres";
import { describe, expect, test } from "bun:test";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("poller", () => {
  test("emits new events to the broadcaster", async () => {
    const tp = await startTestPostgres();
    try {
      const b = new Broadcaster();
      const seen: unknown[] = [];
      b.subscribe(["events"], { send: (_, p) => seen.push(p) });

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
        workflowId: "w",
      });

      const stop = startPoller({ pool: tp.pool, broadcaster: b, intervalMs: 200, batchSize: 100 });
      await wait(100);

      await tp.db.insert(events).values({
        setupId,
        sequence: 1,
        stage: "DETECTOR",
        actor: "x",
        type: "SetupCreated",
        scoreAfter: "25",
        statusBefore: "PROPOSED",
        statusAfter: "REVIEWING",
        payload: {} as never,
      });

      await wait(500);
      stop();
      expect(seen.length).toBeGreaterThanOrEqual(1);
    } finally {
      await tp.cleanup();
    }
  });

  test("does not duplicate events across polls", async () => {
    const tp = await startTestPostgres();
    try {
      const b = new Broadcaster();
      const seen: { id: string }[] = [];
      b.subscribe(["events"], { send: (_, p) => seen.push(p as { id: string }) });

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
        workflowId: "w",
      });
      await tp.db.insert(events).values({
        setupId,
        sequence: 1,
        stage: "DETECTOR",
        actor: "x",
        type: "SetupCreated",
        scoreAfter: "25",
        statusBefore: "PROPOSED",
        statusAfter: "REVIEWING",
        payload: {} as never,
      });

      const stop = startPoller({ pool: tp.pool, broadcaster: b, intervalMs: 100, batchSize: 100 });
      await wait(450);
      stop();

      const ids = new Set(seen.map((e) => e.id));
      expect(ids.size).toBe(seen.length);
    } finally {
      await tp.cleanup();
    }
  });
});
