import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
import { watchConfigs } from "@adapters/persistence/schema";
import { parseTimeframeToMs } from "@domain/ports/Clock";
import { startTestPostgres, type TestPostgres } from "../../helpers/postgres";

let pg: TestPostgres;
let repo: PostgresSetupRepository;

beforeAll(async () => {
  pg = await startTestPostgres();
  repo = new PostgresSetupRepository(pg.db, parseTimeframeToMs);
}, 60_000);

afterAll(async () => {
  await pg.cleanup();
});

describe("PostgresSetupRepository", () => {
  const watchId = crypto.randomUUID();

  test("create + get round-trip", async () => {
    const created = await repo.create({
      id: crypto.randomUUID(),
      watchId,
      asset: "BTCUSDT",
      timeframe: "1h",
      status: "REVIEWING",
      currentScore: 25,
      patternHint: "double_bottom",
      invalidationLevel: 41500,
      direction: "LONG",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86400_000),
      workflowId: `wf-${crypto.randomUUID()}`,
    });
    const fetched = await repo.get(created.id);
    expect(fetched?.asset).toBe("BTCUSDT");
    expect(fetched?.currentScore).toBe(25);
    expect(fetched?.invalidationLevel).toBe(41500);
  });

  test("listAlive excludes terminal statuses", async () => {
    await repo.create({
      id: crypto.randomUUID(),
      watchId,
      asset: "ETHUSDT",
      timeframe: "1h",
      status: "CLOSED",
      currentScore: 0,
      patternHint: null,
      invalidationLevel: null,
      direction: null,
      ttlCandles: 50,
      ttlExpiresAt: new Date(),
      workflowId: `wf-${crypto.randomUUID()}`,
    });
    const alive = await repo.listAlive(watchId);
    expect(alive.every((s) => s.status !== "CLOSED")).toBe(true);
  });

  test("listAliveBySymbol returns alive setups filtered by (symbol, source)", async () => {
    // Insert two watch_configs — both binance but different timeframes
    const watchId1 = crypto.randomUUID();
    const watchId2 = crypto.randomUUID();
    const watchIdOther = crypto.randomUUID();
    await pg.db.insert(watchConfigs).values([
      {
        id: watchId1,
        enabled: true,
        config: { asset: { symbol: "BTCUSDT", source: "binance" } },
        version: 1,
      },
      {
        id: watchId2,
        enabled: true,
        config: { asset: { symbol: "BTCUSDT", source: "binance" } },
        version: 1,
      },
      {
        id: watchIdOther,
        enabled: true,
        config: { asset: { symbol: "BTCUSDT", source: "yahoo" } },
        version: 1,
      },
    ]);

    // Two alive BTCUSDT setups on binance watches
    await repo.create({
      id: crypto.randomUUID(),
      watchId: watchId1,
      asset: "BTCUSDT",
      timeframe: "1h",
      status: "REVIEWING",
      currentScore: 50,
      patternHint: "double_bottom",
      invalidationLevel: 40000,
      direction: "LONG",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86400_000),
      workflowId: `wf-${crypto.randomUUID()}`,
    });
    await repo.create({
      id: crypto.randomUUID(),
      watchId: watchId2,
      asset: "BTCUSDT",
      timeframe: "15m",
      status: "REVIEWING",
      currentScore: 60,
      patternHint: "flag",
      invalidationLevel: 39000,
      direction: "LONG",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86400_000),
      workflowId: `wf-${crypto.randomUUID()}`,
    });
    // One on a yahoo watch — should NOT be included
    await repo.create({
      id: crypto.randomUUID(),
      watchId: watchIdOther,
      asset: "BTCUSDT",
      timeframe: "1d",
      status: "REVIEWING",
      currentScore: 40,
      patternHint: null,
      invalidationLevel: 38000,
      direction: "LONG",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86400_000),
      workflowId: `wf-${crypto.randomUUID()}`,
    });

    const result = await repo.listAliveBySymbol("BTCUSDT", "binance");
    expect(result.length).toBe(2);
    expect(result.every((s) => s.asset === "BTCUSDT")).toBe(true);
  });

  test("markClosed updates status + closedAt", async () => {
    const s = await repo.create({
      id: crypto.randomUUID(),
      watchId,
      asset: "SOLUSDT",
      timeframe: "1h",
      status: "REVIEWING",
      currentScore: 50,
      patternHint: null,
      invalidationLevel: 100,
      direction: "LONG",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86400_000),
      workflowId: `wf-${crypto.randomUUID()}`,
    });
    await repo.markClosed(s.id, "EXPIRED");
    const fetched = await repo.get(s.id);
    expect(fetched?.status).toBe("EXPIRED");
    expect(fetched?.closedAt).not.toBeNull();
  });
});
