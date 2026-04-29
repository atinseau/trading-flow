import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { TrackingArgs, TrackingResult } from "@workflows/setup/trackingLoop";

// One TestWorkflowEnvironment per file — see setupWorkflow.test.ts for
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
  return `tl-${name}-${++__testCounter}`;
}

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

type HarnessActivities = {
  persistEvent: ReturnType<typeof makePersistEvent>;
  notifyTelegramSLHit: (input: unknown) => Promise<unknown>;
  notifyTelegramTPHit: (input: unknown) => Promise<unknown>;
  notifyTelegramInvalidatedAfterConfirmed: (input: unknown) => Promise<unknown>;
  markSetupClosed: (input: unknown) => Promise<unknown>;
};

function makeFakeActivities(onPersist?: (input: FakePersistInput) => void): HarnessActivities {
  return {
    persistEvent: makePersistEvent(onPersist),
    notifyTelegramSLHit: async () => null,
    notifyTelegramTPHit: async () => null,
    notifyTelegramInvalidatedAfterConfirmed: async () => null,
    markSetupClosed: async () => ({}),
  };
}

const baseArgs: TrackingArgs = {
  setupId: "tl-test",
  watchId: "btc-1h",
  asset: "BTCUSDT",
  timeframe: "1h",
  direction: "LONG",
  entry: 100,
  stopLoss: 95,
  invalidationLevel: 90,
  takeProfit: [105, 110, 115],
  scoreAtConfirmation: 80,
};

async function runHarness(
  args: TrackingArgs,
  ticks: { currentPrice: number; observedAt: string }[],
  fakeActivities: HarnessActivities,
  taskQueue: string,
): Promise<TrackingResult> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve("./trackingLoopHarness"),
    activities: fakeActivities,
  });

  return await worker.runUntil(async () => {
    const handle = await env.client.workflow.start("trackingLoopHarness", {
      args: [args],
      workflowId: `${args.setupId}-${__testCounter}`,
      taskQueue,
    });

    // Send all ticks sequentially; the loop processes them one by one.
    for (const tick of ticks) {
      await handle.signal("trackingPrice", tick);
    }

    return (await handle.result()) as TrackingResult;
  });
}

describe("trackingLoop TrackingResult", () => {
  test("returns sl_hit_direct when SL is hit before any TP", async () => {
    const taskQueue = uniqueQueue("sl-direct");
    const persistedTypes: string[] = [];
    const fake = makeFakeActivities((input) => {
      persistedTypes.push(input.event.type);
    });
    const result = await runHarness(
      { ...baseArgs, setupId: "sl-direct" },
      [{ currentPrice: 94, observedAt: new Date().toISOString() }],
      fake,
      taskQueue,
    );
    expect(result).toEqual({ reason: "sl_hit_direct" });
    expect(persistedTypes).toContain("SLHit");
  }, 30_000);

  test("returns sl_hit_after_tp1 when SL is hit after TP1 (trailing breakeven)", async () => {
    const taskQueue = uniqueQueue("sl-after-tp1");
    const persistedTypes: string[] = [];
    const fake = makeFakeActivities((input) => {
      persistedTypes.push(input.event.type);
    });
    // Tick 1: TP1 hit (price 105) — SL trails to entry (100).
    // Tick 2: SL hit at breakeven (price 99 < 100, but > invalidation 90).
    const result = await runHarness(
      { ...baseArgs, setupId: "sl-after-tp1" },
      [
        { currentPrice: 105, observedAt: new Date().toISOString() },
        { currentPrice: 99, observedAt: new Date().toISOString() },
      ],
      fake,
      taskQueue,
    );
    expect(result).toEqual({ reason: "sl_hit_after_tp1" });
    expect(persistedTypes).toContain("TPHit");
    expect(persistedTypes).toContain("TrailingMoved");
    expect(persistedTypes).toContain("SLHit");
  }, 30_000);

  test("returns price_invalidated when invalidation level is breached before SL", async () => {
    const taskQueue = uniqueQueue("price-invalidated");
    const persistedTypes: string[] = [];
    const fake = makeFakeActivities((input) => {
      persistedTypes.push(input.event.type);
    });
    // Set invalidation ABOVE SL so it triggers first.
    // LONG: invalidationLevel=98 (above SL=95) — price 97 breaches invalidation.
    const result = await runHarness(
      {
        ...baseArgs,
        setupId: "price-invalidated",
        stopLoss: 95,
        invalidationLevel: 98,
      },
      [{ currentPrice: 97, observedAt: new Date().toISOString() }],
      fake,
      taskQueue,
    );
    expect(result).toEqual({ reason: "price_invalidated" });
    expect(persistedTypes).toContain("PriceInvalidated");
    // SL must NOT have triggered.
    expect(persistedTypes).not.toContain("SLHit");
  }, 30_000);

  test("returns all_tps_hit when every TP is reached", async () => {
    const taskQueue = uniqueQueue("all-tps");
    const persistedTypes: string[] = [];
    const fake = makeFakeActivities((input) => {
      persistedTypes.push(input.event.type);
    });
    const result = await runHarness(
      { ...baseArgs, setupId: "all-tps" },
      [
        { currentPrice: 105, observedAt: new Date().toISOString() }, // TP1
        { currentPrice: 110, observedAt: new Date().toISOString() }, // TP2
        { currentPrice: 115, observedAt: new Date().toISOString() }, // TP3
      ],
      fake,
      taskQueue,
    );
    expect(result).toEqual({ reason: "all_tps_hit" });
    const tpHitCount = persistedTypes.filter((t) => t === "TPHit").length;
    expect(tpHitCount).toBe(3);
  }, 30_000);
});
