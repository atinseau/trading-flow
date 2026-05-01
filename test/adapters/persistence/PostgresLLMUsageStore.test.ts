import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresLLMUsageStore } from "@adapters/persistence/PostgresLLMUsageStore";
import { llmCalls } from "@adapters/persistence/schema";
import { startTestPostgres, type TestPostgres } from "../../helpers/postgres";

let pg: TestPostgres;
let store: PostgresLLMUsageStore;

beforeAll(async () => {
  pg = await startTestPostgres();
  store = new PostgresLLMUsageStore(pg.db);
}, 60_000);

afterAll(async () => {
  await pg.cleanup();
});

async function insertCall(args: { provider: string; costUsd: number; occurredAt: Date }) {
  await pg.db.insert(llmCalls).values({
    watchId: "test-watch",
    setupId: null,
    stage: "reviewer",
    provider: args.provider,
    model: "fake",
    costUsd: String(args.costUsd),
    occurredAt: args.occurredAt,
  });
}

describe("PostgresLLMUsageStore", () => {
  test("getCallsToday counts llm_calls for provider in current UTC day", async () => {
    const now = new Date();
    await insertCall({ provider: "claude_max", costUsd: 0, occurredAt: now });
    await insertCall({ provider: "claude_max", costUsd: 0, occurredAt: now });

    // Yesterday — should be excluded
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await insertCall({ provider: "claude_max", costUsd: 0, occurredAt: yesterday });

    // Different provider — should be excluded
    await insertCall({ provider: "openrouter", costUsd: 0.001, occurredAt: now });

    expect(await store.getCallsToday("claude_max")).toBe(2);
    expect(await store.getCallsToday("openrouter")).toBe(1);
    expect(await store.getCallsToday("nonexistent")).toBe(0);
  });

  test("getSpentMonthUsd sums cost_usd for provider in current UTC month", async () => {
    // Prior test inserted openrouter once with cost 0.001. Total openrouter MTD = 0.001.
    const spent = await store.getSpentMonthUsd("openrouter");
    expect(spent).toBeGreaterThanOrEqual(0.001);
    expect(spent).toBeLessThan(1); // sanity
  });

  test("getSpentMonthUsd returns 0 for unknown provider", async () => {
    expect(await store.getSpentMonthUsd("nonexistent_provider")).toBe(0);
  });
});
