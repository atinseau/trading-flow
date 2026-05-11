import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresReplayEventStore } from "@adapters/persistence/PostgresReplayEventStore";
import { PostgresReplaySessionRepository } from "@adapters/persistence/PostgresReplaySessionRepository";
import { buildWorkflowId } from "@domain/replay/replaySessionRules";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { startTestPostgres, type TestPostgres } from "../../../helpers/postgres";

let pg: TestPostgres;
let sessionsRepo: PostgresReplaySessionRepository;
let eventsStore: PostgresReplayEventStore;

beforeAll(async () => {
  pg = await startTestPostgres();
  sessionsRepo = new PostgresReplaySessionRepository(pg.db);
  eventsStore = new PostgresReplayEventStore(pg.db);
}, 60_000);

afterAll(async () => {
  await pg.cleanup();
});

async function freshSession(): Promise<string> {
  const id = crypto.randomUUID();
  const s = await sessionsRepo.create({
    id,
    watchId: "btc-1h",
    name: null,
    status: "READY",
    windowStartAt: new Date("2026-04-12T14:00:00.000Z"),
    windowEndAt: new Date("2026-04-13T14:00:00.000Z"),
    workflowId: buildWorkflowId(id),
    configSnapshot: { timeframes: { primary: "1h", higher: [] } } as unknown as WatchConfig,
    lessonsMode: "current",
    feedbackMode: "run",
    costCapUsd: 5,
  });
  return s.id;
}

describe("PostgresReplayEventStore", () => {
  test("append assigns monotonic sequence per session", async () => {
    const sId = await freshSession();
    const setupId = crypto.randomUUID();
    const e1 = await eventsStore.append(sId, {
      setupId,
      occurredAt: new Date("2026-04-12T14:00:00.000Z"),
      stage: "detector",
      actor: "detector_v3",
      type: "DetectorTickProcessed",
      scoreDelta: 0,
      payload: {
        type: "DetectorTickProcessed",
        data: { ignoreReason: "no pattern" },
      },
    });
    const e2 = await eventsStore.append(sId, {
      setupId,
      occurredAt: new Date("2026-04-12T15:00:00.000Z"),
      stage: "detector",
      actor: "detector_v3",
      type: "DetectorTickProcessed",
      scoreDelta: 0,
      payload: {
        type: "DetectorTickProcessed",
        data: { ignoreReason: "still nothing" },
      },
    });
    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
  });

  test("sequence is per-session (two sessions, same setup id)", async () => {
    const sA = await freshSession();
    const sB = await freshSession();
    const setupId = crypto.randomUUID();
    const eA = await eventsStore.append(sA, {
      setupId,
      occurredAt: new Date(),
      stage: "detector",
      actor: "detector_v3",
      type: "DetectorTickProcessed",
      scoreDelta: 0,
      payload: { type: "DetectorTickProcessed", data: { ignoreReason: "x" } },
    });
    const eB = await eventsStore.append(sB, {
      setupId,
      occurredAt: new Date(),
      stage: "detector",
      actor: "detector_v3",
      type: "DetectorTickProcessed",
      scoreDelta: 0,
      payload: { type: "DetectorTickProcessed", data: { ignoreReason: "y" } },
    });
    expect(eA.sequence).toBe(1);
    expect(eB.sequence).toBe(1);
  });

  test("listBySession returns events in sequence order", async () => {
    const sId = await freshSession();
    for (let i = 0; i < 3; i++) {
      await eventsStore.append(sId, {
        setupId: null,
        occurredAt: new Date(),
        stage: "detector",
        actor: "detector_v3",
        type: "DetectorTickProcessed",
        scoreDelta: 0,
        payload: { type: "DetectorTickProcessed", data: { ignoreReason: `t${i}` } },
      });
    }
    const list = await eventsStore.listBySession(sId);
    expect(list.length).toBe(3);
    expect(list.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  test("listBySession respects sinceSeq", async () => {
    const sId = await freshSession();
    for (let i = 0; i < 5; i++) {
      await eventsStore.append(sId, {
        setupId: null,
        occurredAt: new Date(),
        stage: "detector",
        actor: "detector_v3",
        type: "DetectorTickProcessed",
        scoreDelta: 0,
        payload: { type: "DetectorTickProcessed", data: { ignoreReason: `t${i}` } },
      });
    }
    const tail = await eventsStore.listBySession(sId, { sinceSeq: 2 });
    expect(tail.map((e) => e.sequence)).toEqual([3, 4, 5]);
  });

  test("countBySession", async () => {
    const sId = await freshSession();
    expect(await eventsStore.countBySession(sId)).toBe(0);
    await eventsStore.append(sId, {
      setupId: null,
      occurredAt: new Date(),
      stage: "detector",
      actor: "detector_v3",
      type: "DetectorTickProcessed",
      scoreDelta: 0,
      payload: { type: "DetectorTickProcessed", data: { ignoreReason: "x" } },
    });
    expect(await eventsStore.countBySession(sId)).toBe(1);
  });

  test("cascade delete via session removal", async () => {
    const sId = await freshSession();
    await eventsStore.append(sId, {
      setupId: null,
      occurredAt: new Date(),
      stage: "detector",
      actor: "detector_v3",
      type: "DetectorTickProcessed",
      scoreDelta: 0,
      payload: { type: "DetectorTickProcessed", data: { ignoreReason: "x" } },
    });
    await sessionsRepo.delete(sId);
    expect(await eventsStore.countBySession(sId)).toBe(0);
  });
});
