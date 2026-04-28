import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { getStateQuery, type InitialEvidence, setupWorkflow } from "@workflows/setup/setupWorkflow";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

const baseInitial: InitialEvidence = {
  setupId: "test-setup",
  watchId: "btc-1h",
  asset: "BTCUSDT",
  timeframe: "1h",
  patternHint: "double_bottom",
  direction: "LONG",
  invalidationLevel: 41500,
  initialScore: 25,
  ttlExpiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
  scoreThresholdFinalizer: 80,
  scoreThresholdDead: 10,
  scoreMax: 100,
};

describe("SetupWorkflow", () => {
  test("CANDIDATE -> REVIEWING after creation, score = initial", async () => {
    const fakeActivities = {
      nextSequence: async () => ({ sequence: 1 }),
      persistEvent: async () => ({ id: "evt-1" }),
      runReviewer: async () => ({
        verdictJson: JSON.stringify({ verdict: { type: "NEUTRAL" } }),
        costUsd: 0,
        eventAlreadyExisted: false,
      }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
        costUsd: 0,
      }),
      markSetupClosed: async () => {},
      listEventsForSetup: async () => [],
      loadSetup: async () => null,
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [{ ...baseInitial, setupId: "test-1" }],
        workflowId: "test-1",
        taskQueue: "test",
      });
      const state = await handle.query(getStateQuery);
      expect(state.status).toBe("REVIEWING");
      expect(state.score).toBe(25);
      await handle.signal("close", { reason: "test_done" });
      await handle.result();
    });
  }, 30_000);

  test("STRENGTHEN crossing threshold -> FINALIZING -> REJECTED if no go", async () => {
    const fakeActivities = {
      nextSequence: async () => ({ sequence: 1 }),
      persistEvent: async () => ({ id: "evt-1" }),
      runReviewer: async () => ({
        verdictJson: JSON.stringify({ verdict: { type: "STRENGTHEN", scoreDelta: 60 } }),
        costUsd: 0,
        eventAlreadyExisted: false,
      }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
        costUsd: 0,
      }),
      markSetupClosed: async () => {},
      listEventsForSetup: async () => [],
      loadSetup: async () => null,
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [{ ...baseInitial, setupId: "test-2" }],
        workflowId: "test-2",
        taskQueue: "test",
      });
      await handle.signal("review", { tickSnapshotId: "snap-1" });
      const result = await handle.result();
      expect(result).toBe("REJECTED");
    });
  }, 30_000);

  test("priceCheck below invalidation -> INVALIDATED", async () => {
    const fakeActivities = {
      nextSequence: async () => ({ sequence: 1 }),
      persistEvent: async () => ({ id: "evt-1" }),
      runReviewer: async () => ({
        verdictJson: JSON.stringify({ verdict: { type: "NEUTRAL" } }),
        costUsd: 0,
        eventAlreadyExisted: false,
      }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
        costUsd: 0,
      }),
      markSetupClosed: async () => {},
      listEventsForSetup: async () => [],
      loadSetup: async () => null,
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [{ ...baseInitial, setupId: "test-3" }],
        workflowId: "test-3",
        taskQueue: "test",
      });
      await handle.signal("priceCheck", {
        currentPrice: 41000,
        observedAt: new Date().toISOString(),
      });
      const result = await handle.result();
      expect(result).toBe("INVALIDATED");
    });
  }, 30_000);
});
