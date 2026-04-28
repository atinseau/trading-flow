import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresEventStore } from "@adapters/persistence/PostgresEventStore";
import { setups } from "@adapters/persistence/schema";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { Wait } from "testcontainers";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let store: PostgresEventStore;

beforeAll(async () => {
  // Override default wait strategy: Bun + testcontainers hangs on Wait.forListeningPorts
  // (https://github.com/oven-sh/bun/issues/21342). Log-message wait works fine in Bun.
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./migrations" });
  store = new PostgresEventStore(db);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

async function createTestSetup(): Promise<string> {
  const [row] = await db
    .insert(setups)
    .values({
      watchId: crypto.randomUUID(),
      asset: "BTCUSDT",
      timeframe: "1h",
      status: "REVIEWING",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86_400_000),
      workflowId: `wf-${crypto.randomUUID()}`,
    })
    .returning({ id: setups.id });
  return row!.id;
}

describe("PostgresEventStore", () => {
  test("nextSequence returns 1 for fresh setup", async () => {
    const id = await createTestSetup();
    expect(await store.nextSequence(id)).toBe(1);
  });

  test("append + listForSetup returns events in sequence order", async () => {
    const id = await createTestSetup();
    await store.append(
      {
        setupId: id,
        sequence: 1,
        stage: "detector",
        actor: "detector_v1",
        type: "SetupCreated",
        scoreDelta: 0,
        scoreAfter: 25,
        statusBefore: "CANDIDATE",
        statusAfter: "REVIEWING",
        payload: {
          type: "SetupCreated",
          data: {
            pattern: "double_bottom",
            direction: "LONG",
            keyLevels: { invalidation: 41500 },
            initialScore: 25,
            rawObservation: "x",
          },
        },
      },
      { score: 25, status: "REVIEWING" },
    );

    await store.append(
      {
        setupId: id,
        sequence: 2,
        stage: "reviewer",
        actor: "reviewer_v1",
        type: "Strengthened",
        scoreDelta: 10,
        scoreAfter: 35,
        statusBefore: "REVIEWING",
        statusAfter: "REVIEWING",
        payload: {
          type: "Strengthened",
          data: {
            reasoning: "v",
            observations: [],
            source: "reviewer_full",
          },
        },
      },
      { score: 35, status: "REVIEWING" },
    );

    const events = await store.listForSetup(id);
    expect(events.map((e) => e.type)).toEqual(["SetupCreated", "Strengthened"]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  test("findByInputHash returns existing event for idempotence", async () => {
    const id = await createTestSetup();
    await store.append(
      {
        setupId: id,
        sequence: 1,
        stage: "reviewer",
        actor: "x",
        type: "Strengthened",
        scoreDelta: 5,
        scoreAfter: 30,
        statusBefore: "REVIEWING",
        statusAfter: "REVIEWING",
        inputHash: `deadbeef${"0".repeat(56)}`,
        payload: {
          type: "Strengthened",
          data: { reasoning: "v", observations: [], source: "reviewer_full" },
        },
      },
      { score: 30, status: "REVIEWING" },
    );

    const found = await store.findByInputHash(id, `deadbeef${"0".repeat(56)}`);
    expect(found).not.toBeNull();
    expect(found?.type).toBe("Strengthened");
  });

  test("UNIQUE(setupId, sequence) prevents duplicates", async () => {
    const id = await createTestSetup();
    const evt = {
      setupId: id,
      sequence: 1,
      stage: "detector" as const,
      actor: "x",
      type: "SetupCreated" as const,
      scoreDelta: 0,
      scoreAfter: 25,
      statusBefore: "CANDIDATE" as const,
      statusAfter: "REVIEWING" as const,
      payload: {
        type: "SetupCreated" as const,
        data: {
          pattern: "x",
          direction: "LONG" as const,
          keyLevels: { invalidation: 1 },
          initialScore: 25,
          rawObservation: "x",
        },
      },
    };
    await store.append(evt, { score: 25, status: "REVIEWING" });
    await expect(store.append(evt, { score: 25, status: "REVIEWING" })).rejects.toThrow();
  });

  test("append updates setups state in same transaction", async () => {
    const id = await createTestSetup();
    await store.append(
      {
        setupId: id,
        sequence: 1,
        stage: "reviewer",
        actor: "x",
        type: "Strengthened",
        scoreDelta: 10,
        scoreAfter: 35,
        statusBefore: "REVIEWING",
        statusAfter: "FINALIZING",
        payload: {
          type: "Strengthened",
          data: { reasoning: "v", observations: [], source: "reviewer_full" },
        },
      },
      { score: 35, status: "FINALIZING", invalidationLevel: 41700 },
    );

    const [row] = await db.select().from(setups).where(eq(setups.id, id));
    expect(row?.status).toBe("FINALIZING");
    expect(Number(row?.currentScore)).toBe(35);
    expect(Number(row?.invalidationLevel)).toBe(41700);
  });
});
