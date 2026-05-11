import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresReplaySessionRepository } from "@adapters/persistence/PostgresReplaySessionRepository";
import { buildWorkflowId } from "@domain/replay/replaySessionRules";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { startTestPostgres, type TestPostgres } from "../../../helpers/postgres";

let pg: TestPostgres;
let repo: PostgresReplaySessionRepository;

beforeAll(async () => {
  pg = await startTestPostgres();
  repo = new PostgresReplaySessionRepository(pg.db);
}, 60_000);

afterAll(async () => {
  await pg.cleanup();
});

const minimalConfig = { timeframes: { primary: "1h", higher: [] } } as unknown as WatchConfig;

function mkInput(overrides: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  return {
    id,
    watchId: "btc-1h",
    name: null,
    status: "READY" as const,
    windowStartAt: new Date("2026-04-12T14:00:00.000Z"),
    windowEndAt: new Date("2026-04-13T14:00:00.000Z"),
    workflowId: buildWorkflowId(id),
    configSnapshot: minimalConfig,
    lessonsMode: "current" as const,
    feedbackMode: "run" as const,
    costCapUsd: 5,
    ...overrides,
  };
}

describe("PostgresReplaySessionRepository", () => {
  test("create + get round-trip", async () => {
    const created = await repo.create(mkInput());
    expect(created.status).toBe("READY");
    expect(created.costUsdSoFar).toBe(0);
    expect(created.costCapUsd).toBe(5);

    const fetched = await repo.get(created.id);
    expect(fetched?.watchId).toBe("btc-1h");
    expect(fetched?.lessonsMode).toBe("current");
    expect(fetched?.feedbackMode).toBe("run");
  });

  test("get returns null for unknown id", async () => {
    expect(await repo.get(crypto.randomUUID())).toBeNull();
  });

  test("list filters by watchId and status", async () => {
    await repo.create(mkInput({ watchId: "eth-4h", status: "PAUSED" }));
    await repo.create(mkInput({ watchId: "eth-4h", status: "READY" }));

    const ethReady = await repo.list({ watchId: "eth-4h", status: "READY" });
    expect(ethReady.length).toBeGreaterThanOrEqual(1);
    for (const s of ethReady) {
      expect(s.watchId).toBe("eth-4h");
      expect(s.status).toBe("READY");
    }
  });

  test("list orders by createdAt desc and respects limit", async () => {
    const all = await repo.list({ limit: 2 });
    expect(all.length).toBeLessThanOrEqual(2);
    if (all.length === 2 && all[0] && all[1]) {
      expect(all[0].createdAt.getTime()).toBeGreaterThanOrEqual(all[1].createdAt.getTime());
    }
  });

  test("updateStatus updates status and failureReason", async () => {
    const s = await repo.create(mkInput());
    await repo.updateStatus(s.id, "FAILED", "boom");
    const after = await repo.get(s.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.failureReason).toBe("boom");
  });

  test("incrementCost is atomic (two concurrent calls sum)", async () => {
    const s = await repo.create(mkInput());
    await Promise.all([repo.incrementCost(s.id, 0.5), repo.incrementCost(s.id, 0.3)]);
    const after = await repo.get(s.id);
    expect(after?.costUsdSoFar).toBeCloseTo(0.8, 5);
  });

  test("delete removes the row", async () => {
    const s = await repo.create(mkInput());
    await repo.delete(s.id);
    expect(await repo.get(s.id)).toBeNull();
  });

  test("status CHECK constraint rejects invalid value", async () => {
    await expect(repo.create(mkInput({ status: "BOGUS" }))).rejects.toThrow();
  });

  test("window CHECK constraint rejects inverted window", async () => {
    await expect(
      repo.create(
        mkInput({
          windowStartAt: new Date("2026-04-13T00:00:00.000Z"),
          windowEndAt: new Date("2026-04-12T00:00:00.000Z"),
        }),
      ),
    ).rejects.toThrow();
  });

  test("lessons_mode CHECK constraint rejects invalid mode", async () => {
    await expect(repo.create(mkInput({ lessonsMode: "yolo" }))).rejects.toThrow();
  });

  test("workflow_id is unique", async () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    const sharedWfId = buildWorkflowId(id1);
    await repo.create(mkInput({ id: id1, workflowId: sharedWfId }));
    await expect(repo.create(mkInput({ id: id2, workflowId: sharedWfId }))).rejects.toThrow();
  });
});
