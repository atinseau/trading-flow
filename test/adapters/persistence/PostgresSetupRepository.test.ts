import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
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

  test("listAliveWithInvalidation filters out null invalidation", async () => {
    await repo.create({
      id: crypto.randomUUID(),
      watchId,
      asset: "DOGEUSDT",
      timeframe: "1h",
      status: "REVIEWING",
      currentScore: 30,
      patternHint: null,
      invalidationLevel: null,
      direction: "LONG",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86400_000),
      workflowId: `wf-${crypto.randomUUID()}`,
    });
    const list = await repo.listAliveWithInvalidation(watchId);
    expect(list.every((s) => s.invalidationLevel != null)).toBe(true);
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
