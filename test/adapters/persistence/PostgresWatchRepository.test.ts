import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PostgresWatchRepository } from "@adapters/persistence/PostgresWatchRepository";
import { watchConfigs } from "@adapters/persistence/schema";
import { startTestPostgres, type TestPostgres } from "../../helpers/postgres";

let pg: TestPostgres;
let repo: PostgresWatchRepository;

beforeAll(async () => {
  pg = await startTestPostgres();
  repo = new PostgresWatchRepository(pg.db);
}, 60_000);

afterAll(async () => {
  await pg.cleanup();
});

const validBinanceWatch = {
  id: "btc-1h",
  enabled: true,
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: [] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50,
    score_initial: 25,
    score_threshold_finalizer: 80,
    score_threshold_dead: 10,
    invalidation_policy: "strict",
    score_max: 100,
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
    reviewer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
  },
};

describe("PostgresWatchRepository", () => {
  beforeEach(async () => {
    await pg.db.delete(watchConfigs);
  });

  test("findEnabled returns valid + enabled watches only", async () => {
    await pg.db.insert(watchConfigs).values([
      { id: "btc-1h", enabled: true, config: validBinanceWatch },
      {
        id: "btc-disabled",
        enabled: false,
        config: { ...validBinanceWatch, id: "btc-disabled", enabled: false },
      },
      {
        id: "broken",
        enabled: true,
        config: { id: "broken", asset: { source: "yahoo", symbol: "AAPL" } },
      },
    ]);
    const results = await repo.findEnabled();
    expect(results.map((r) => r.id).sort()).toEqual(["btc-1h"]);
  });

  test("findAll returns all valid watches regardless of enabled", async () => {
    await pg.db.insert(watchConfigs).values([
      { id: "btc-1h", enabled: true, config: validBinanceWatch },
      {
        id: "btc-disabled",
        enabled: false,
        config: { ...validBinanceWatch, id: "btc-disabled", enabled: false },
      },
      { id: "broken", enabled: true, config: { foo: "bar" } },
    ]);
    const results = await repo.findAll();
    expect(results.map((r) => r.id).sort()).toEqual(["btc-1h", "btc-disabled"]);
  });

  test("findById returns watch when valid, null when missing or invalid", async () => {
    await pg.db.insert(watchConfigs).values([
      { id: "btc-1h", enabled: true, config: validBinanceWatch },
      { id: "broken", enabled: true, config: { foo: "bar" } },
    ]);
    expect((await repo.findById("btc-1h"))?.id).toBe("btc-1h");
    expect(await repo.findById("missing")).toBeNull();
    expect(await repo.findById("broken")).toBeNull();
  });

  test("findAllWithValidation returns valid + invalid rows", async () => {
    await pg.db.insert(watchConfigs).values([
      { id: "btc-1h", enabled: true, config: validBinanceWatch },
      { id: "broken", enabled: true, config: { foo: "bar" } },
    ]);
    const results = await repo.findAllWithValidation();
    const valid = results.find((r) => r.id === "btc-1h");
    const broken = results.find((r) => r.id === "broken");
    expect(valid?.watch?.id).toBe("btc-1h");
    expect(valid?.error).toBeUndefined();
    expect(broken?.watch).toBeUndefined();
    expect(broken?.error).toBeTruthy();
  });

  test("excludes soft-deleted rows (deletedAt !== null)", async () => {
    await pg.db.insert(watchConfigs).values([
      { id: "btc-1h", enabled: true, config: validBinanceWatch },
      { id: "deleted", enabled: true, config: validBinanceWatch, deletedAt: new Date() },
    ]);
    const results = await repo.findAll();
    expect(results.map((r) => r.id)).toEqual(["btc-1h"]);
  });
});
