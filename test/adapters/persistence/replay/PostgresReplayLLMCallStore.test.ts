import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgresReplayLLMCallStore } from "@adapters/persistence/PostgresReplayLLMCallStore";
import { PostgresReplaySessionRepository } from "@adapters/persistence/PostgresReplaySessionRepository";
import { buildWorkflowId } from "@domain/replay/replaySessionRules";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { startTestPostgres, type TestPostgres } from "../../../helpers/postgres";

let pg: TestPostgres;
let sessionsRepo: PostgresReplaySessionRepository;
let callsStore: PostgresReplayLLMCallStore;

beforeAll(async () => {
  pg = await startTestPostgres();
  sessionsRepo = new PostgresReplaySessionRepository(pg.db);
  callsStore = new PostgresReplayLLMCallStore(pg.db);
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

describe("PostgresReplayLLMCallStore", () => {
  test("record + costBreakdown aggregates per stage", async () => {
    const sId = await freshSession();
    await callsStore.record({
      sessionId: sId,
      setupId: null,
      stage: "detector",
      provider: "claude_max",
      model: "claude-sonnet-4-6",
      promptTokens: 1000,
      completionTokens: 500,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd: 0.01,
      latencyMs: 4200,
      cacheHit: false,
    });
    await callsStore.record({
      sessionId: sId,
      setupId: null,
      stage: "detector",
      provider: "claude_max",
      model: "claude-sonnet-4-6",
      promptTokens: 800,
      completionTokens: 300,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd: 0.008,
      latencyMs: 3800,
      cacheHit: true,
    });
    await callsStore.record({
      sessionId: sId,
      setupId: null,
      stage: "reviewer",
      provider: "claude_max",
      model: "claude-haiku-4-5",
      promptTokens: 500,
      completionTokens: 200,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd: 0.002,
      latencyMs: 1200,
      cacheHit: false,
    });

    const breakdown = await callsStore.costBreakdown(sId);
    expect(breakdown.length).toBe(2);
    const detector = breakdown.find((b) => b.stage === "detector");
    const reviewer = breakdown.find((b) => b.stage === "reviewer");
    expect(detector?.totalCostUsd).toBeCloseTo(0.018, 5);
    expect(detector?.calls).toBe(2);
    expect(detector?.cacheHits).toBe(1);
    expect(reviewer?.totalCostUsd).toBeCloseTo(0.002, 5);
    expect(reviewer?.calls).toBe(1);
    expect(reviewer?.cacheHits).toBe(0);
  });

  test("costBreakdown returns empty for fresh session", async () => {
    const sId = await freshSession();
    expect(await callsStore.costBreakdown(sId)).toEqual([]);
  });

  test("breakdown sorted by totalCostUsd desc", async () => {
    const sId = await freshSession();
    await callsStore.record({
      sessionId: sId,
      setupId: null,
      stage: "reviewer",
      provider: "claude_max",
      model: "claude-haiku-4-5",
      promptTokens: 100,
      completionTokens: 50,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd: 0.001,
      cacheHit: false,
    });
    await callsStore.record({
      sessionId: sId,
      setupId: null,
      stage: "finalizer",
      provider: "claude_max",
      model: "claude-opus-4-7",
      promptTokens: 1000,
      completionTokens: 500,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd: 0.1,
      cacheHit: false,
    });
    const breakdown = await callsStore.costBreakdown(sId);
    expect(breakdown[0]?.stage).toBe("finalizer");
    expect(breakdown[1]?.stage).toBe("reviewer");
  });
});
