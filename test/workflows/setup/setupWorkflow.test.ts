import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { getStateQuery, type InitialEvidence, setupWorkflow } from "@workflows/setup/setupWorkflow";

// One TestWorkflowEnvironment shared across all tests in the file. We can't
// recreate per-test because the Temporal native Runtime is a process-global
// singleton: tearing down between tests closes it ("Client already closed"
// on the next Worker.create).
//
// We use `createLocal` (real Temporal time, not time-skipping) so that
// tests are deterministic: no shared simulated clock advancing between
// tests, no TTL timer racing review signals. The TTL-exhaustion behavior
// is exercised by the Postgres integration test instead, which can use
// time-skipping safely (single test in that file).
let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
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
  patternCategory: "accumulation",
  expectedMaturationTicks: 4,
  allowSameTickFastPath: true,
  direction: "LONG",
  invalidationLevel: 41500,
  initialScore: 25,
  ttlCandles: 50,
  // 1-year TTL: TestWorkflowEnvironment.createTimeSkipping() fast-forwards
  // simulated time when the workflow awaits, so a short TTL (e.g. 4h) can
  // fire before signals are processed and race with the review path. A
  // very long TTL guarantees the timer never trips within the test scope.
  // The dedicated TTL test overrides this with a short value.
  ttlExpiresAt: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
  scoreThresholdFinalizer: 80,
  scoreThresholdDead: 10,
  scoreMax: 100,
  detectorPromptVersion: "detector_v3",
  // Feedback disabled — these tests focus on the setup workflow itself; the
  // feedback child-workflow path is covered by setupWorkflow.feedback.test.ts.
  feedbackEnabled: false,
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

// Each test gets its own task queue so that worker leaks (e.g. timeouts) in
// one test cannot interfere with another via the "Registration of multiple
// workers with overlapping worker task types" error.
let __testCounter = 0;
function uniqueQueue(name: string): string {
  return `test-${name}-${++__testCounter}`;
}

/**
 * Build a fake `persistEvent` that mirrors the production EventStore contract:
 * the store assigns the sequence atomically. Returns a `StoredEvent`-shaped
 * record with monotonically increasing `sequence` per setupId.
 */
type FakePersistInput = {
  event: {
    setupId: string;
    type: string;
    statusBefore?: string;
    statusAfter?: string;
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

describe("SetupWorkflow", () => {
  test("CANDIDATE -> REVIEWING after creation, score = initial", async () => {
    const taskQueue = uniqueQueue("candidate-reviewing");
    const fakeActivities = {
      createSetup: async () => ({}),
      persistEvent: makePersistEvent(),
      runReviewer: async () => baseRunReviewerReturn({ type: "NEUTRAL", observations: [] }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
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
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [{ ...baseInitial, setupId: "test-1" }],
        workflowId: `test-1-${__testCounter}`,
        taskQueue,
      });
      const state = await handle.query(getStateQuery);
      expect(state.status).toBe("REVIEWING");
      expect(state.score).toBe(25);
      await handle.signal("close", { reason: "test_done" });
      await handle.result();
    });
  }, 30_000);

  test("STRENGTHEN crossing threshold -> FINALIZING -> REJECTED if no go", async () => {
    const taskQueue = uniqueQueue("strengthen-rejected");
    const fakeActivities = {
      createSetup: async () => ({}),
      persistEvent: makePersistEvent(),
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
        promptVersion: "finalizer_v3",
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
      taskQueue,
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [{ ...baseInitial, setupId: "test-2" }],
        workflowId: `test-2-${__testCounter}`,
        taskQueue,
      });
      await handle.signal("review", { tickSnapshotId: "snap-1" });
      const result = await handle.result();
      expect(result).toBe("REJECTED");
    });
  }, 30_000);

  test("STRENGTHEN -> FINALIZING -> GO -> TRACKING -> all TPs hit -> CLOSED", async () => {
    const taskQueue = uniqueQueue("tracking-tp");
    const tpHitNotifications: Array<{ index: number; isFinal: boolean }> = [];
    const slHitNotifications: number[] = [];
    const persistedTypes: string[] = [];

    const fakeActivities = {
      createSetup: async () => ({}),
      persistEvent: makePersistEvent((input) => {
        persistedTypes.push(input.event.type);
      }),
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
        promptVersion: "finalizer_v3",
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
      taskQueue,
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [
          {
            ...baseInitial,
            setupId: "test-tracking-tp",
            // Below the SL=95 / entry=100 path so the trackingLoop's
            // price-invalidation check doesn't trigger before the TP path.
            invalidationLevel: 80,
          },
        ],
        workflowId: `test-tracking-tp-${__testCounter}`,
        taskQueue,
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
    const taskQueue = uniqueQueue("tracking-sl");
    const slHitNotifications: number[] = [];
    const persistedTypes: string[] = [];

    const fakeActivities = {
      createSetup: async () => ({}),
      persistEvent: makePersistEvent((input) => {
        persistedTypes.push(input.event.type);
      }),
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
      notifyTelegramSLHit: async (input: { level: number }) => {
        slHitNotifications.push(input.level);
        return null;
      },
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [
          {
            ...baseInitial,
            setupId: "test-tracking-sl",
            // Below the SL=95 / target tick=90 path so trackingLoop's
            // price-invalidation check doesn't fire before the SL path.
            invalidationLevel: 50,
          },
        ],
        workflowId: `test-tracking-sl-${__testCounter}`,
        taskQueue,
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

  // SKIPPED: TTL exhaustion needs time-skipping (`env.sleep("5h")`) which
  // requires `createTimeSkipping`. We use `createLocal` here for
  // deterministic real-time semantics across multiple tests in this file
  // (time-skipping mutates a shared simulated clock and races between
  // tests). The TTL path is covered by the Postgres integration test.
  test.skip("TTL exhaustion -> Expired event persisted + Telegram fired", async () => {
    const taskQueue = uniqueQueue("ttl-expired");
    const persistedEvents: { type: string; statusBefore: string; statusAfter: string }[] = [];
    let telegramExpiredCalled = false;

    const fakeActivities = {
      createSetup: async () => ({}),
      persistEvent: makePersistEvent((input) => {
        persistedEvents.push({
          type: input.event.type,
          statusBefore: input.event.statusBefore ?? "",
          statusAfter: input.event.statusAfter ?? "",
        });
      }),
      runReviewer: async () => baseRunReviewerReturn({ type: "NEUTRAL", observations: [] }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
        costUsd: 0,
        promptVersion: "finalizer_v3",
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
      taskQueue,
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });

    // TTL = 4 hours from "now"; we'll time-skip 5 hours forward to trigger it.
    const ttlExpiresAt = new Date(Date.now() + 4 * 3600_000).toISOString();

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [{ ...baseInitial, setupId: "test-ttl-expired", ttlExpiresAt }],
        workflowId: `test-ttl-expired-${__testCounter}`,
        taskQueue,
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
    const taskQueue = uniqueQueue("tracking-short");
    const persistedTypes: string[] = [];
    const tpHitNotifications: Array<{ index: number; isFinal: boolean }> = [];

    const fakeActivities = {
      createSetup: async () => ({}),
      persistEvent: makePersistEvent((input) => {
        persistedTypes.push(input.event.type);
      }),
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
        promptVersion: "finalizer_v3",
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
      taskQueue,
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
        workflowId: `test-tracking-short-${__testCounter}`,
        taskQueue,
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
    const taskQueue = uniqueQueue("price-invalidated");
    const fakeActivities = {
      createSetup: async () => ({}),
      persistEvent: makePersistEvent(),
      runReviewer: async () => baseRunReviewerReturn({ type: "NEUTRAL", observations: [] }),
      runFinalizer: async () => ({
        decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
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
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
      activities: fakeActivities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(setupWorkflow, {
        args: [{ ...baseInitial, setupId: "test-3" }],
        workflowId: `test-3-${__testCounter}`,
        taskQueue,
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
