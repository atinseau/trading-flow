import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresLLMUsageStore } from "@adapters/persistence/PostgresLLMUsageStore";
import { events, setups } from "@adapters/persistence/schema";
import { startTestPostgres, type TestPostgres } from "../../helpers/postgres";

let pg: TestPostgres;
let store: PostgresLLMUsageStore;
let testSetupId: string;

beforeAll(async () => {
  pg = await startTestPostgres();
  store = new PostgresLLMUsageStore(pg.db);

  // Seed a setup row (events have FK to setups)
  const [s] = await pg.db
    .insert(setups)
    .values({
      watchId: "test-watch",
      asset: "BTCUSDT",
      timeframe: "1h",
      status: "REVIEWING",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86400_000),
      workflowId: `wf-${crypto.randomUUID()}`,
    })
    .returning({ id: setups.id });
  testSetupId = s?.id;
}, 60_000);

afterAll(async () => {
  await pg.cleanup();
});

async function insertEvent(args: {
  provider: string;
  costUsd: number;
  occurredAt: Date;
  sequence: number;
}) {
  await pg.db.insert(events).values({
    setupId: testSetupId,
    sequence: args.sequence,
    stage: "reviewer",
    actor: "test",
    type: "Strengthened",
    scoreDelta: "0",
    scoreAfter: "50",
    statusBefore: "REVIEWING",
    statusAfter: "REVIEWING",
    payload: {
      type: "Strengthened",
      data: { reasoning: "x", observations: [], source: "reviewer_full" },
    },
    provider: args.provider,
    model: "fake",
    costUsd: String(args.costUsd),
    occurredAt: args.occurredAt,
  });
}

describe("PostgresLLMUsageStore", () => {
  test("getCallsToday counts events for provider in current UTC day", async () => {
    const now = new Date();
    await insertEvent({ provider: "claude_max", costUsd: 0, occurredAt: now, sequence: 1 });
    await insertEvent({ provider: "claude_max", costUsd: 0, occurredAt: now, sequence: 2 });

    // Yesterday — should be excluded
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await insertEvent({ provider: "claude_max", costUsd: 0, occurredAt: yesterday, sequence: 3 });

    // Different provider — should be excluded
    await insertEvent({ provider: "openrouter", costUsd: 0.001, occurredAt: now, sequence: 4 });

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
