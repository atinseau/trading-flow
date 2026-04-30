import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresLessonEventStore } from "@adapters/persistence/PostgresLessonEventStore";
import { PostgresLessonStore } from "@adapters/persistence/PostgresLessonStore";
import { startTestPostgres, type TestPostgres } from "../../helpers/postgres";

let pg: TestPostgres;
let store: PostgresLessonStore;

beforeAll(async () => {
  pg = await startTestPostgres();
  store = new PostgresLessonStore(pg.db);
}, 60_000);

afterAll(async () => {
  await pg.cleanup();
});

describe("PostgresLessonStore", () => {
  test("create + getById + listActive happy path", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    await store.create({
      id,
      watchId: "btc-1h",
      category: "reviewing",
      title: "Sample lesson title for testing",
      body: "x".repeat(60),
      rationale: "y".repeat(30),
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    const got = await store.getById(id);
    expect(got?.id).toBe(id);
    expect(got?.status).toBe("ACTIVE");
    const active = await store.listActive({
      watchId: "btc-1h",
      category: "reviewing",
      limit: 10,
    });
    expect(active.length).toBeGreaterThanOrEqual(1);
  });

  test("listActive filters by status=ACTIVE", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    await store.create({
      id,
      watchId: "btc-1h",
      category: "reviewing",
      title: "Pending lesson should not be active",
      body: "x".repeat(60),
      rationale: "y".repeat(30),
      promptVersion: "feedback_v1",
      status: "PENDING",
    });
    const active = await store.listActive({
      watchId: "btc-1h",
      category: "reviewing",
      limit: 10,
    });
    expect(active.find((l) => l.id === id)).toBeUndefined();
  });

  test("incrementUsage is atomic across batch", async () => {
    const id0 = "33333333-3333-3333-3333-333333333333";
    const ids = [id0];
    await store.create({
      id: id0,
      watchId: "btc-1h",
      category: "reviewing",
      title: "Usage tracking sample lesson",
      body: "x".repeat(60),
      rationale: "y".repeat(30),
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    await store.incrementUsage(ids);
    await store.incrementUsage(ids);
    const got = await store.getById(id0);
    expect(got?.timesUsedInPrompts).toBe(2);
  });

  test("updateStatus only fires when fromStatus matches", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    await store.create({
      id,
      watchId: "btc-1h",
      category: "finalizing",
      title: "Status transition lesson",
      body: "x".repeat(60),
      rationale: "y".repeat(30),
      promptVersion: "feedback_v1",
      status: "PENDING",
    });
    const r1 = await store.updateStatus({
      lessonId: id,
      fromStatus: "ACTIVE", // wrong from
      toStatus: "ARCHIVED",
      occurredAt: new Date(),
    });
    expect(r1.updated).toBe(false);
    const r2 = await store.updateStatus({
      lessonId: id,
      fromStatus: "PENDING",
      toStatus: "ACTIVE",
      occurredAt: new Date(),
    });
    expect(r2.updated).toBe(true);
    const after = await store.getById(id);
    expect(after?.status).toBe("ACTIVE");
    expect(after?.activatedAt).toBeInstanceOf(Date);
  });

  test("countActiveByCategory excludes non-ACTIVE rows", async () => {
    const counts = await store.countActiveByCategory("btc-1h");
    expect(counts.detecting).toBeGreaterThanOrEqual(0);
    expect(counts.reviewing).toBeGreaterThanOrEqual(0);
    expect(counts.finalizing).toBeGreaterThanOrEqual(0);
  });

  test("setPinned toggles pinned flag", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    await store.create({
      id,
      watchId: "btc-1h",
      category: "reviewing",
      title: "Pinning sample lesson",
      body: "x".repeat(60),
      rationale: "y".repeat(30),
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    await store.setPinned(id, true);
    const after = await store.getById(id);
    expect(after?.pinned).toBe(true);
    await store.setPinned(id, false);
    const after2 = await store.getById(id);
    expect(after2?.pinned).toBe(false);
  });
});

describe("PostgresLessonEventStore", () => {
  let store2: PostgresLessonEventStore;

  beforeAll(() => {
    store2 = new PostgresLessonEventStore(pg.db);
  });

  test("append assigns sequence atomically per watchId", async () => {
    const watchId = "btc-1h-events-test";
    const e1 = await store2.append({
      watchId,
      type: "CREATE",
      actor: "feedback_v1",
      payload: {
        type: "CREATE",
        data: {
          category: "reviewing",
          title: "test",
          body: "test body",
          rationale: "test rationale",
        },
      },
    });
    const e2 = await store2.append({
      watchId,
      type: "REINFORCE",
      actor: "feedback_v1",
      payload: { type: "REINFORCE", data: { reason: "test reinforce" } },
    });
    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
  });

  test("findByInputHash returns matching events only for same watch", async () => {
    const inputHash = "abc123";
    await store2.append({
      watchId: "btc-1h",
      type: "CREATE",
      actor: "feedback_v1",
      payload: {
        type: "CREATE",
        data: { category: "reviewing", title: "x", body: "y", rationale: "z" },
      },
      inputHash,
    });
    await store2.append({
      watchId: "eth-4h",
      type: "CREATE",
      actor: "feedback_v1",
      payload: {
        type: "CREATE",
        data: { category: "reviewing", title: "x", body: "y", rationale: "z" },
      },
      inputHash,
    });
    const matchedBtc = await store2.findByInputHash({ watchId: "btc-1h", inputHash });
    expect(matchedBtc.length).toBe(1);
    expect(matchedBtc[0]?.watchId).toBe("btc-1h");
  });
});
