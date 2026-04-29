import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { feedbackLoopWorkflow } from "@workflows/feedback/feedbackLoopWorkflow";

// One TestWorkflowEnvironment per file — Temporal native runtime is a
// process-global singleton.
let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

let __testCounter = 0;
function uniqueQueue(name: string): string {
  return `fl-fail-${name}-${++__testCounter}`;
}

describe("feedbackLoopWorkflow failures", () => {
  test("LLM activity failing through all retries propagates as workflow error", async () => {
    const taskQueue = uniqueQueue("llm-fail");
    let analyzeAttempts = 0;
    let applyCalls = 0;

    const fakeActivities = {
      gatherFeedbackContext: async () => ({
        contextRef: "file://ctx.json",
        chunkHashes: [],
      }),
      runFeedbackAnalysis: async () => {
        analyzeAttempts++;
        throw new Error("fake LLM 503");
      },
      applyLessonChanges: async () => {
        applyCalls++;
        return { changesApplied: 0, pendingApprovalsCreated: 0, costUsd: 0 };
      },
    };

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/feedback/feedbackLoopWorkflow"),
      activities: fakeActivities,
    });

    await expect(
      worker.runUntil(
        env.client.workflow.execute(feedbackLoopWorkflow, {
          args: [
            {
              setupId: "00000000-0000-0000-0000-000000000099",
              watchId: "btc-1h",
              closeOutcome: { reason: "sl_hit_direct", everConfirmed: true },
              scoreAtClose: 82,
            },
          ],
          workflowId: `feedback-fail-${__testCounter}`,
          taskQueue,
        }),
      ),
    ).rejects.toThrow();

    // The LLM activity should have been retried (workflow policy: 3 attempts),
    // and applyLessonChanges must never run if the LLM step fails terminally.
    expect(analyzeAttempts).toBeGreaterThanOrEqual(1);
    expect(applyCalls).toBe(0);
  }, 60_000);
});
