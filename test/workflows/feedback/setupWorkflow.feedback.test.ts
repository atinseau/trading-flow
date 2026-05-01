import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { feedbackWorkflowId } from "@workflows/feedback/feedbackLoopWorkflow";
import { getStateQuery, type InitialEvidence, setupWorkflow } from "@workflows/setup/setupWorkflow";

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
  return `setup-fb-${name}-${++__testCounter}`;
}

const baseInitial: InitialEvidence = {
  setupId: "test-setup",
  watchId: "btc-1h",
  asset: "BTCUSDT",
  timeframe: "1h",
  patternHint: "double_bottom",
  patternCategory: "accumulation",
  expectedMaturationTicks: 4,
  allowSameTickFastPath: true,
  direction: "LONG",
  invalidationLevel: 50,
  initialScore: 25,
  ttlCandles: 50,
  ttlExpiresAt: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
  scoreThresholdFinalizer: 80,
  scoreThresholdDead: 10,
  scoreMax: 100,
  detectorPromptVersion: "detector_v3",
  feedbackEnabled: true,
};

const baseRunReviewerReturn = (verdict: unknown) => ({
  verdictJson: JSON.stringify(verdict),
  costUsd: 0,
  eventAlreadyExisted: false,
  inputHash: "test-hash",
  promptVersion: "reviewer_v3",
  provider: "fake",
  model: "fake-model",
});

type FakePersistInput = {
  event: {
    setupId: string;
    type: string;
    [k: string]: unknown;
  };
  setupUpdate: unknown;
};

function makePersistEvent(onPersist?: (input: FakePersistInput) => void) {
  const seqBySetup = new Map<string, number>();
  return async (input: FakePersistInput) => {
    onPersist?.(input);
    const prev = seqBySetup.get(input.event.setupId) ?? 0;
    const sequence = prev + 1;
    seqBySetup.set(input.event.setupId, sequence);
    return {
      ...input.event,
      sequence,
      id: `evt-${input.event.setupId}-${sequence}`,
      occurredAt: new Date(),
    };
  };
}

/**
 * Common fake activities for the setup workflow + feedback activities. Caller
 * provides:
 *  - finalizerDecision: shape returned by runFinalizer (entry/sl/tps).
 *  - feedbackHooks: counters bumped by the feedback activities.
 */
function makeFakeActivities(opts: {
  onPersist?: (input: FakePersistInput) => void;
  finalizerDecision: {
    go: boolean;
    reasoning: string;
    entry?: number;
    stop_loss?: number;
    take_profit?: number[];
  };
  feedbackHooks: { gather: number; analyze: number; apply: number };
}) {
  return {
    // Setup activities
    createSetup: async () => ({}),
    persistEvent: makePersistEvent(opts.onPersist),
    runReviewer: async () =>
      baseRunReviewerReturn({
        type: "STRENGTHEN",
        scoreDelta: 60,
        observations: [],
        reasoning: "looks strong",
      }),
    runFinalizer: async () => ({
      decisionJson: JSON.stringify(opts.finalizerDecision),
      costUsd: 0,
      promptVersion: "finalizer_v3",
    }),
    markSetupClosed: async () => {},
    listEventsForSetup: async () => [],
    loadSetup: async () => null,
    notifyTelegramConfirmed: async () => null,
    notifyTelegramRejected: async () => null,
    notifyTelegramInvalidatedAfterConfirmed: async () => null,
    notifyTelegramExpired: async () => null,
    notifyTelegramTPHit: async () => null,
    notifyTelegramSLHit: async () => null,
    // Feedback activities (the child workflow's needs).
    gatherFeedbackContext: async () => {
      opts.feedbackHooks.gather++;
      return { contextRef: "file://ctx.json", chunkHashes: ["a"] };
    },
    runFeedbackAnalysis: async () => {
      opts.feedbackHooks.analyze++;
      return {
        summary: "ok",
        actions: [],
        provider: "fake",
        model: "fake-model",
        promptVersion: "feedback_v1",
        inputHash: "fb-hash",
        costUsd: 0.05,
        latencyMs: 50,
        cached: false,
      };
    },
    applyLessonChanges: async () => {
      opts.feedbackHooks.apply++;
      return { changesApplied: 0, pendingApprovalsCreated: 0, costUsd: 0.05 };
    },
  };
}

async function waitForTracking(handle: Awaited<ReturnType<typeof env.client.workflow.start>>) {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const state = await handle.query(getStateQuery);
    if (state.status === "TRACKING") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("setup never reached TRACKING within 10s");
}

describe("setupWorkflow → feedbackLoopWorkflow", () => {
  test("starts child feedbackLoopWorkflow when SLHit closes a confirmed setup", async () => {
    const taskQueue = uniqueQueue("sl-direct");
    const feedbackHooks = { gather: 0, analyze: 0, apply: 0 };
    const setupId = `test-fb-sl-direct-${__testCounter}`;
    const fakes = makeFakeActivities({
      finalizerDecision: {
        go: true,
        reasoning: "ok",
        entry: 100,
        stop_loss: 95,
        take_profit: [110, 120],
      },
      feedbackHooks,
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakes,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [
          {
            ...baseInitial,
            setupId,
            // Below SL=95 so trackingLoop's price-invalidation check doesn't
            // fire before SL.
            invalidationLevel: 50,
            feedbackEnabled: true,
          },
        ],
        workflowId: `setup-${setupId}`,
        taskQueue,
      });

      await handle.signal("review", { tickSnapshotId: "snap-1" });
      await waitForTracking(handle);

      // SL hit at 90 (below stop_loss 95) — expect close reason sl_hit_direct.
      await handle.signal("trackingPrice", {
        currentPrice: 90,
        observedAt: new Date().toISOString(),
      });

      const result = await handle.result();
      expect(result).toBe("CLOSED");

      // Wait for the abandoned child to complete. parentClosePolicy:ABANDON
      // means the child is independent of parent close — we still poll its
      // result via the workflow ID we know it must have.
      const child = env.client.workflow.getHandle(feedbackWorkflowId(setupId));
      const childResult = (await child.result()) as { changesApplied: number };
      expect(childResult).toBeDefined();
    });

    expect(feedbackHooks.gather).toBe(1);
    expect(feedbackHooks.analyze).toBe(1);
    expect(feedbackHooks.apply).toBe(1);
  }, 60_000);

  test("does NOT start child workflow when feedback.enabled is false", async () => {
    const taskQueue = uniqueQueue("disabled");
    const feedbackHooks = { gather: 0, analyze: 0, apply: 0 };
    const setupId = `test-fb-disabled-${__testCounter}`;
    const fakes = makeFakeActivities({
      finalizerDecision: {
        go: true,
        reasoning: "ok",
        entry: 100,
        stop_loss: 95,
        take_profit: [110, 120],
      },
      feedbackHooks,
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakes,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [
          {
            ...baseInitial,
            setupId,
            invalidationLevel: 50,
            feedbackEnabled: false, // disabled — no child workflow expected
          },
        ],
        workflowId: `setup-${setupId}`,
        taskQueue,
      });

      await handle.signal("review", { tickSnapshotId: "snap-1" });
      await waitForTracking(handle);

      await handle.signal("trackingPrice", {
        currentPrice: 90,
        observedAt: new Date().toISOString(),
      });

      const result = await handle.result();
      expect(result).toBe("CLOSED");

      // The child workflow with feedback-<setupId> must not exist.
      const child = env.client.workflow.getHandle(feedbackWorkflowId(setupId));
      let threw = false;
      try {
        await child.describe();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    expect(feedbackHooks.gather).toBe(0);
    expect(feedbackHooks.analyze).toBe(0);
    expect(feedbackHooks.apply).toBe(0);
  }, 60_000);

  test("does NOT start child workflow when close reason is all_tps_hit", async () => {
    const taskQueue = uniqueQueue("all-tps");
    const feedbackHooks = { gather: 0, analyze: 0, apply: 0 };
    const setupId = `test-fb-all-tps-${__testCounter}`;
    const fakes = makeFakeActivities({
      finalizerDecision: {
        go: true,
        reasoning: "ok",
        entry: 100,
        stop_loss: 95,
        take_profit: [105, 110],
      },
      feedbackHooks,
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakes,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [
          {
            ...baseInitial,
            setupId,
            // Keep invalidation below the entry path so trackingLoop
            // doesn't intercept first.
            invalidationLevel: 50,
            feedbackEnabled: true,
          },
        ],
        workflowId: `setup-${setupId}`,
        taskQueue,
      });

      await handle.signal("review", { tickSnapshotId: "snap-1" });
      await waitForTracking(handle);

      // Hit TP1 → SL trails to entry. Hit TP2 (final) → all_tps_hit.
      await handle.signal("trackingPrice", {
        currentPrice: 105,
        observedAt: new Date().toISOString(),
      });
      await handle.signal("trackingPrice", {
        currentPrice: 110,
        observedAt: new Date().toISOString(),
      });

      const result = await handle.result();
      expect(result).toBe("CLOSED");

      // No feedback child workflow is expected — all_tps_hit is not eligible.
      const child = env.client.workflow.getHandle(feedbackWorkflowId(setupId));
      let threw = false;
      try {
        await child.describe();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    expect(feedbackHooks.gather).toBe(0);
    expect(feedbackHooks.analyze).toBe(0);
    expect(feedbackHooks.apply).toBe(0);
  }, 60_000);
});
