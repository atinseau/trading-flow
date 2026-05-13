import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresLLMResponseCacheStore } from "@adapters/persistence/PostgresLLMResponseCacheStore";
import { startTestPostgres, type TestPostgres } from "../../../helpers/postgres";

let pg: TestPostgres;
let cache: PostgresLLMResponseCacheStore;

beforeAll(async () => {
  pg = await startTestPostgres();
  cache = new PostgresLLMResponseCacheStore(pg.db);
}, 60_000);

afterAll(async () => {
  await pg.cleanup();
});

function mkEntry(hash: string, costUsd = 0.005) {
  return {
    inputHash: hash,
    provider: "claude_max",
    model: "claude-sonnet-4-6",
    promptVersion: "detector_v3",
    responseJson: { verdict: "ignore", reason: "no pattern" },
    promptTokens: 1000,
    completionTokens: 200,
    costUsd,
  };
}

describe("PostgresLLMResponseCacheStore", () => {
  test("get returns null for unknown hash", async () => {
    expect(await cache.get(`miss-${crypto.randomUUID()}`)).toBeNull();
  });

  test("set then get round-trip", async () => {
    const hash = `h-${crypto.randomUUID()}`;
    await cache.set(mkEntry(hash, 0.012));
    const got = await cache.get(hash);
    expect(got?.inputHash).toBe(hash);
    expect(got?.provider).toBe("claude_max");
    expect(got?.costUsd).toBeCloseTo(0.012, 5);
    expect(got?.hitCount).toBe(0);
  });

  test("set twice on same hash : second is no-op (first writer wins)", async () => {
    const hash = `h-${crypto.randomUUID()}`;
    await cache.set(mkEntry(hash, 0.005));
    await cache.set({ ...mkEntry(hash, 0.999), responseJson: { changed: true } });
    const got = await cache.get(hash);
    expect(got?.costUsd).toBeCloseTo(0.005, 5);
    expect((got?.responseJson as { changed?: boolean }).changed).toBeUndefined();
  });

  test("touchHit increments hitCount and updates lastUsedAt", async () => {
    const hash = `h-${crypto.randomUUID()}`;
    await cache.set(mkEntry(hash));
    const before = await cache.get(hash);
    const tBefore = before?.lastUsedAt.getTime() ?? 0;

    // Small delay to ensure lastUsedAt observably moves
    await new Promise((r) => setTimeout(r, 20));

    await cache.touchHit(hash);
    await cache.touchHit(hash);

    const after = await cache.get(hash);
    expect(after?.hitCount).toBe(2);
    expect((after?.lastUsedAt.getTime() ?? 0) >= tBefore).toBe(true);
  });

  test("touchHit on unknown hash is a no-op (does not throw)", async () => {
    await cache.touchHit(`miss-${crypto.randomUUID()}`);
  });
});
