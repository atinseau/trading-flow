import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { feedbackLoopWorkflow } from "@workflows/feedback/feedbackLoopWorkflow";

// One TestWorkflowEnvironment per file — see setupWorkflow.test.ts for the
// rationale (Temporal native runtime is a process-global singleton).
let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

let __testCounter = 0;
function uniqueQueue(name: string): string {
  return `fl-${name}-${++__testCounter}`;
}

describe("feedbackLoopWorkflow", () => {
  test("happy path: gather → analyze → apply", async () => {
    const taskQueue = uniqueQueue("happy");
    const captured = { gather: 0, analyze: 0, apply: 0 };
    const fakeActivities = {
      gatherFeedbackContext: async () => {
        captured.gather++;
        return { contextRef: "file://ctx.json", chunkHashes: ["a", "b"] };
      },
      runFeedbackAnalysis: async () => {
        captured.analyze++;
        return {
          summary: "ok",
          actions: [],
          provider: "fake",
          model: "fake-model",
          promptVersion: "feedback_v1",
          inputHash: "hash",
          costUsd: 0.1,
          latencyMs: 100,
          cached: false,
        };
      },
      applyLessonChanges: async () => {
        captured.apply++;
        return { changesApplied: 0, pendingApprovalsCreated: 0, costUsd: 0.1 };
      },
    };

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/feedback/feedbackLoopWorkflow"),
      activities: fakeActivities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(feedbackLoopWorkflow, {
        args: [
          {
            setupId: "00000000-0000-0000-0000-000000000001",
            watchId: "btc-1h",
            closeOutcome: { reason: "sl_hit_direct", everConfirmed: true },
            scoreAtClose: 82,
          },
        ],
        workflowId: `feedback-test-${__testCounter}`,
        taskQueue,
      }),
    );

    expect(captured).toEqual({ gather: 1, analyze: 1, apply: 1 });
    expect(result.costUsd).toBeCloseTo(0.1, 2);
    expect(result.changesApplied).toBe(0);
    expect(result.pendingApprovalsCreated).toBe(0);
  }, 30_000);
});
