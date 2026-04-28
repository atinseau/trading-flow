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
  ttlCandles: 50,
  ttlExpiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
  scoreThresholdFinalizer: 80,
  scoreThresholdDead: 10,
  scoreMax: 100,
};

const baseRunReviewerReturn = (
  verdict: unknown,
): {
  verdictJson: string;
  costUsd: number;
  eventAlreadyExisted: boolean;
  inputHash: string;
  promptVersion: string;
  provider: string;
  model: string;
} => ({
  verdictJson: JSON.stringify(verdict),
  costUsd: 0,
  eventAlreadyExisted: false,
  inputHash: "test-hash",
  promptVersion: "reviewer_v1",
  provider: "fake",
  model: "fake-model",
});

describe("SetupWorkflow", () => {
  test("CANDIDATE -> REVIEWING after creation, score = initial", async () => {
    const fakeActivities = {
      createSetup: async () => ({}),
      nextSequence: async () => ({ sequence: 1 }),
      persistEvent: async () => ({ id: "evt-1" }),
      runReviewer: async () => baseRunReviewerReturn({ type: "NEUTRAL", observations: [] }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
        costUsd: 0,
      }),
      markSetupClosed: async () => {},
      listEventsForSetup: async () => [],
      loadSetup: async () => null,
      notifyTelegramConfirmed: async () => null,
      notifyTelegramRejected: async () => null,
      notifyTelegramInvalidatedAfterConfirmed: async () => null,
      notifyTelegramExpired: async () => null,
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
      createSetup: async () => ({}),
      nextSequence: async () => ({ sequence: 1 }),
      persistEvent: async () => ({ id: "evt-1" }),
      runReviewer: async () =>
        baseRunReviewerReturn({
          type: "STRENGTHEN",
          scoreDelta: 60,
          observations: [],
          reasoning: "looks strong",
        }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
        costUsd: 0,
      }),
      markSetupClosed: async () => {},
      listEventsForSetup: async () => [],
      loadSetup: async () => null,
      notifyTelegramConfirmed: async () => null,
      notifyTelegramRejected: async () => null,
      notifyTelegramInvalidatedAfterConfirmed: async () => null,
      notifyTelegramExpired: async () => null,
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

  test("STRENGTHEN -> FINALIZING -> GO -> TRACKING -> all TPs hit -> CLOSED", async () => {
    let seqCounter = 0;
    const tpHitNotifications: Array<{ index: number; isFinal: boolean }> = [];
    const slHitNotifications: number[] = [];
    const persistedTypes: string[] = [];

    const fakeActivities = {
      createSetup: async () => ({}),
      nextSequence: async () => ({ sequence: ++seqCounter }),
      persistEvent: async (input: { event: { type: string } }) => {
        persistedTypes.push(input.event.type);
        return { id: `evt-${persistedTypes.length}` };
      },
      runReviewer: async () =>
        baseRunReviewerReturn({
          type: "STRENGTHEN",
          scoreDelta: 60,
          observations: [],
          reasoning: "looks strong",
        }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({
          go: true,
          reasoning: "ok",
          entry: 100,
          stop_loss: 95,
          take_profit: [105, 110],
        }),
        costUsd: 0,
      }),
      markSetupClosed: async () => {},
      listEventsForSetup: async () => [],
      loadSetup: async () => null,
      notifyTelegramConfirmed: async () => null,
      notifyTelegramRejected: async () => null,
      notifyTelegramInvalidatedAfterConfirmed: async () => null,
      notifyTelegramExpired: async () => null,
      notifyTelegramTPHit: async (input: { index: number; isFinal: boolean }) => {
        tpHitNotifications.push({ index: input.index, isFinal: input.isFinal });
        return null;
      },
      notifyTelegramSLHit: async (input: { level: number }) => {
        slHitNotifications.push(input.level);
        return null;
      },
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [{ ...baseInitial, setupId: "test-tracking-tp" }],
        workflowId: "test-tracking-tp",
        taskQueue: "test",
      });
      await handle.signal("review", { tickSnapshotId: "snap-1" });

      // Wait until TRACKING phase is entered before sending prices.
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const state = await handle.query(getStateQuery);
        if (state.status === "TRACKING") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // TP1 hit (also moves SL to breakeven)
      await handle.signal("trackingPrice", {
        currentPrice: 105,
        observedAt: new Date().toISOString(),
      });
      // TP2 hit (final)
      await handle.signal("trackingPrice", {
        currentPrice: 110,
        observedAt: new Date().toISOString(),
      });

      const result = await handle.result();
      expect(result).toBe("CLOSED");
    });

    expect(persistedTypes).toContain("TPHit");
    expect(persistedTypes).toContain("TrailingMoved");
    expect(tpHitNotifications.length).toBeGreaterThanOrEqual(2);
    expect(tpHitNotifications.some((n) => n.isFinal)).toBe(true);
    expect(slHitNotifications.length).toBe(0);
  }, 30_000);

  test("STRENGTHEN -> FINALIZING -> GO -> TRACKING -> SL hit -> CLOSED", async () => {
    let seqCounter = 0;
    const slHitNotifications: number[] = [];
    const persistedTypes: string[] = [];

    const fakeActivities = {
      createSetup: async () => ({}),
      nextSequence: async () => ({ sequence: ++seqCounter }),
      persistEvent: async (input: { event: { type: string } }) => {
        persistedTypes.push(input.event.type);
        return { id: `evt-${persistedTypes.length}` };
      },
      runReviewer: async () =>
        baseRunReviewerReturn({
          type: "STRENGTHEN",
          scoreDelta: 60,
          observations: [],
          reasoning: "looks strong",
        }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({
          go: true,
          reasoning: "ok",
          entry: 100,
          stop_loss: 95,
          take_profit: [110, 120],
        }),
        costUsd: 0,
      }),
      markSetupClosed: async () => {},
      listEventsForSetup: async () => [],
      loadSetup: async () => null,
      notifyTelegramConfirmed: async () => null,
      notifyTelegramRejected: async () => null,
      notifyTelegramInvalidatedAfterConfirmed: async () => null,
      notifyTelegramExpired: async () => null,
      notifyTelegramTPHit: async () => null,
      notifyTelegramSLHit: async (input: { level: number }) => {
        slHitNotifications.push(input.level);
        return null;
      },
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [{ ...baseInitial, setupId: "test-tracking-sl" }],
        workflowId: "test-tracking-sl",
        taskQueue: "test",
      });
      await handle.signal("review", { tickSnapshotId: "snap-1" });

      // Wait until TRACKING phase
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const state = await handle.query(getStateQuery);
        if (state.status === "TRACKING") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // SL hit at 90 (below stop_loss 95)
      await handle.signal("trackingPrice", {
        currentPrice: 90,
        observedAt: new Date().toISOString(),
      });

      const result = await handle.result();
      expect(result).toBe("CLOSED");
    });

    expect(persistedTypes).toContain("SLHit");
    expect(slHitNotifications).toContain(95);
  }, 30_000);

  test("TTL exhaustion -> Expired event persisted + Telegram fired", async () => {
    let seqCounter = 0;
    const persistedEvents: { type: string; statusBefore: string; statusAfter: string }[] = [];
    let telegramExpiredCalled = false;

    const fakeActivities = {
      createSetup: async () => ({}),
      nextSequence: async () => ({ sequence: ++seqCounter }),
      persistEvent: async (input: {
        event: { type: string; statusBefore: string; statusAfter: string };
      }) => {
        persistedEvents.push({
          type: input.event.type,
          statusBefore: input.event.statusBefore,
          statusAfter: input.event.statusAfter,
        });
        return { id: `evt-${persistedEvents.length}` };
      },
      runReviewer: async () => baseRunReviewerReturn({ type: "NEUTRAL", observations: [] }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
        costUsd: 0,
      }),
      markSetupClosed: async () => {},
      listEventsForSetup: async () => [],
      loadSetup: async () => null,
      notifyTelegramConfirmed: async () => null,
      notifyTelegramRejected: async () => null,
      notifyTelegramInvalidatedAfterConfirmed: async () => null,
      notifyTelegramTPHit: async () => null,
      notifyTelegramSLHit: async () => null,
      notifyTelegramExpired: async () => {
        telegramExpiredCalled = true;
        return { messageId: 1 };
      },
    };

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });

    // TTL = 4 hours from "now"; we'll time-skip 5 hours forward to trigger it.
    const ttlExpiresAt = new Date(Date.now() + 4 * 3600_000).toISOString();

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [{ ...baseInitial, setupId: "test-ttl-expired", ttlExpiresAt }],
        workflowId: "test-ttl-expired",
        taskQueue: "test",
      });

      // Time-skip 5 hours forward to trigger TTL expiration.
      await env.sleep("5h");

      const result = await handle.result();
      expect(result).toBe("EXPIRED");
    });

    // Verify Expired event was persisted with the correct status transition
    const expiredEvent = persistedEvents.find((e) => e.type === "Expired");
    expect(expiredEvent).toBeDefined();
    expect(expiredEvent?.statusAfter).toBe("EXPIRED");

    // Verify Telegram was called
    expect(telegramExpiredCalled).toBe(true);
  }, 30_000);

  test("GO path SHORT direction -> TPs hit (price descending) -> CLOSED", async () => {
    let seqCounter = 0;
    const persistedTypes: string[] = [];
    const tpHitNotifications: Array<{ index: number; isFinal: boolean }> = [];

    const fakeActivities = {
      createSetup: async () => ({}),
      nextSequence: async () => ({ sequence: ++seqCounter }),
      persistEvent: async (input: { event: { type: string } }) => {
        persistedTypes.push(input.event.type);
        return { id: `evt-${persistedTypes.length}` };
      },
      runReviewer: async () =>
        baseRunReviewerReturn({
          type: "STRENGTHEN",
          scoreDelta: 60,
          observations: [],
          reasoning: "looks strong",
        }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({
          go: true,
          reasoning: "ok short",
          entry: 100,
          stop_loss: 105, // SHORT: SL above entry
          take_profit: [95, 90], // SHORT: TPs below entry
        }),
        costUsd: 0,
      }),
      markSetupClosed: async () => {},
      listEventsForSetup: async () => [],
      loadSetup: async () => null,
      notifyTelegramConfirmed: async () => null,
      notifyTelegramRejected: async () => null,
      notifyTelegramInvalidatedAfterConfirmed: async () => null,
      notifyTelegramExpired: async () => null,
      notifyTelegramTPHit: async (input: { index: number; isFinal: boolean }) => {
        tpHitNotifications.push({ index: input.index, isFinal: input.isFinal });
        return null;
      },
      notifyTelegramSLHit: async () => null,
    };

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [
          {
            ...baseInitial,
            setupId: "test-tracking-short",
            direction: "SHORT" as const,
          },
        ],
        workflowId: "test-tracking-short",
        taskQueue: "test",
      });

      await handle.signal("review", { tickSnapshotId: "snap-1" });

      // Wait until TRACKING phase before sending prices.
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const state = await handle.query(getStateQuery);
        if (state.status === "TRACKING") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // SHORT: price descends to TP1 (also moves SL to breakeven)
      await handle.signal("trackingPrice", {
        currentPrice: 95,
        observedAt: new Date().toISOString(),
      });
      // SHORT: price descends to TP2 (final)
      await handle.signal("trackingPrice", {
        currentPrice: 90,
        observedAt: new Date().toISOString(),
      });

      const result = await handle.result();
      expect(result).toBe("CLOSED");
    });

    expect(persistedTypes).toContain("TPHit");
    expect(persistedTypes).toContain("TrailingMoved");
    expect(tpHitNotifications.length).toBeGreaterThanOrEqual(2);
    expect(tpHitNotifications.some((n) => n.isFinal)).toBe(true);
  }, 30_000);

  test("priceCheck below invalidation -> INVALIDATED", async () => {
    const fakeActivities = {
      createSetup: async () => ({}),
      nextSequence: async () => ({ sequence: 1 }),
      persistEvent: async () => ({ id: "evt-1" }),
      runReviewer: async () => baseRunReviewerReturn({ type: "NEUTRAL", observations: [] }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
        costUsd: 0,
      }),
      markSetupClosed: async () => {},
      listEventsForSetup: async () => [],
      loadSetup: async () => null,
      notifyTelegramConfirmed: async () => null,
      notifyTelegramRejected: async () => null,
      notifyTelegramInvalidatedAfterConfirmed: async () => null,
      notifyTelegramExpired: async () => null,
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
