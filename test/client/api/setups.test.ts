import { describe, expect, test } from "bun:test";
import { events, setups, tickSnapshots } from "@adapters/persistence/schema";
import { makeSetupsApi } from "@client/api/setups";
import { startTestPostgres } from "@test-helpers/postgres";

const setupRow = (overrides: Partial<typeof setups.$inferInsert> = {}) => ({
  id: crypto.randomUUID(),
  watchId: "btc-1h",
  asset: "BTCUSDT",
  timeframe: "1h",
  status: "REVIEWING",
  currentScore: "55",
  ttlCandles: 50,
  ttlExpiresAt: new Date(Date.now() + 1e9),
  workflowId: `wf-${crypto.randomUUID().slice(0, 8)}`,
  direction: "LONG",
  ...overrides,
});

describe("setups API", () => {
  test("GET /api/setups returns all setups, filtered by watchId", async () => {
    const tp = await startTestPostgres();
    try {
      await tp.db
        .insert(setups)
        .values([setupRow({ watchId: "btc-1h" }), setupRow({ watchId: "eth-4h" })]);
      const api = makeSetupsApi({ db: tp.db });
      const all = await api.list(new Request("http://x/api/setups"));
      expect(((await all.json()) as unknown[]).length).toBe(2);

      const filtered = await api.list(new Request("http://x/api/setups?watchId=btc-1h"));
      const items = (await filtered.json()) as { watchId: string }[];
      expect(items.length).toBe(1);
      expect(items[0]!.watchId).toBe("btc-1h");
    } finally {
      await tp.cleanup();
    }
  });

  test("GET /api/setups/:id returns 200 or 404", async () => {
    const tp = await startTestPostgres();
    try {
      const row = setupRow();
      await tp.db.insert(setups).values(row);
      const api = makeSetupsApi({ db: tp.db });
      const ok = await api.get(new Request("http://x"), { id: row.id });
      expect(ok.status).toBe(200);
      const miss = await api.get(new Request("http://x"), { id: crypto.randomUUID() });
      expect(miss.status).toBe(404);
    } finally {
      await tp.cleanup();
    }
  });

  test("GET /api/setups/:id/events returns events ordered by sequence", async () => {
    const tp = await startTestPostgres();
    try {
      const row = setupRow();
      await tp.db.insert(setups).values(row);
      await tp.db.insert(events).values([
        {
          setupId: row.id,
          sequence: 1,
          stage: "DETECTOR",
          actor: "x",
          type: "SetupCreated",
          scoreAfter: "25",
          statusBefore: "PROPOSED",
          statusAfter: "REVIEWING",
          payload: {} as never,
        },
        {
          setupId: row.id,
          sequence: 2,
          stage: "REVIEWER",
          actor: "x",
          type: "Strengthened",
          scoreDelta: "10",
          scoreAfter: "35",
          statusBefore: "REVIEWING",
          statusAfter: "REVIEWING",
          payload: {} as never,
        },
      ]);
      const api = makeSetupsApi({ db: tp.db });
      const res = await api.events(new Request("http://x"), { id: row.id });
      const items = (await res.json()) as { sequence: number }[];
      expect(items.map((e) => e.sequence)).toEqual([1, 2]);
    } finally {
      await tp.cleanup();
    }
  });

  test("GET /api/setups/:id/ohlcv streams the latest tick OHLCV file", async () => {
    const tp = await startTestPostgres();
    try {
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "tf-ohlcv-"));
      process.env.ARTIFACTS_BASE_DIR = dir;
      const ohlcvPath = join(dir, "ohlcv.json");
      writeFileSync(
        ohlcvPath,
        JSON.stringify([{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }]),
      );

      const row = setupRow();
      await tp.db.insert(setups).values(row);
      await tp.db.insert(tickSnapshots).values({
        watchId: "btc-1h",
        tickAt: new Date(),
        asset: "BTCUSDT",
        timeframe: "1h",
        ohlcvUri: `file://${ohlcvPath}`,
        chartUri: `file://${ohlcvPath}`,
        indicators: {} as never,
        preFilterPass: true,
      });

      const api = makeSetupsApi({ db: tp.db });
      const res = await api.ohlcv(new Request("http://x"), { id: row.id });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
    } finally {
      await tp.cleanup();
    }
  });
});
