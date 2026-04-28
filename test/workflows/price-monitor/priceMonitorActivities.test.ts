import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SystemClock } from "@adapters/time/SystemClock";
import { FakePriceFeed } from "@test-fakes/FakePriceFeed";
import { InMemorySetupRepository } from "@test-fakes/InMemorySetupRepository";
import type { ActivityDeps } from "@workflows/activityDependencies";

// The price monitor activity calls `Context.current().heartbeat(...)`. Outside
// a real Temporal activity context that throws, so we mock it with a no-op
// before importing the activity factory.
mock.module("@temporalio/activity", () => ({
  Context: {
    current: () => ({
      heartbeat: () => {},
    }),
  },
}));

// Import after the module mock so the activity uses our stub.
const { buildPriceMonitorActivities } = await import("@workflows/price-monitor/activities");

type SignalCall = { workflowId: string; signalName: string; args: unknown };

function makeMockTemporalClient(): {
  // biome-ignore lint/suspicious/noExplicitAny: minimal mock shaped only for activity usage
  client: any;
  calls: SignalCall[];
} {
  const calls: SignalCall[] = [];
  const client = {
    workflow: {
      getHandle: (workflowId: string) => ({
        signal: async (signalName: string, args: unknown) => {
          calls.push({ workflowId, signalName, args });
        },
      }),
    },
  };
  return { client, calls };
}

describe("priceMonitor activity dispatch", () => {
  let priceFeed: FakePriceFeed;
  let setupRepo: InMemorySetupRepository;
  let mockClient: ReturnType<typeof makeMockTemporalClient>;
  let activities: ReturnType<typeof buildPriceMonitorActivities>;

  beforeEach(() => {
    priceFeed = new FakePriceFeed();
    setupRepo = new InMemorySetupRepository();
    mockClient = makeMockTemporalClient();

    const deps = {
      setupRepo,
      priceFeeds: new Map([["fake", priceFeed]]),
      temporalClient: mockClient.client,
      clock: new SystemClock(),
    } as unknown as ActivityDeps;

    activities = buildPriceMonitorActivities(deps);
  });

  afterEach(() => {
    priceFeed.end();
  });

  test("REVIEWING setup: signals 'priceCheck' only on breach", async () => {
    await setupRepo.create({
      id: "setup-1",
      watchId: "btc-1h",
      asset: "BTCUSDT",
      timeframe: "1h",
      status: "REVIEWING",
      currentScore: 50,
      patternHint: "double_bottom",
      invalidationLevel: 41500,
      direction: "LONG",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86400_000),
      workflowId: "setup-wf-1",
    });

    const subscribePromise = activities.subscribeAndCheckPriceFeed({
      watchId: "btc-1h",
      adapter: "fake",
      assets: ["BTCUSDT"],
    });

    // Tick above invalidation -- should NOT signal.
    priceFeed.emit({ asset: "BTCUSDT", price: 42000, timestamp: new Date() });
    await Bun.sleep(50);
    expect(mockClient.calls.length).toBe(0);

    // Tick below invalidation -- SHOULD signal priceCheck.
    priceFeed.emit({ asset: "BTCUSDT", price: 41000, timestamp: new Date() });
    await Bun.sleep(50);
    expect(mockClient.calls.length).toBe(1);
    expect(mockClient.calls[0]?.workflowId).toBe("setup-wf-1");
    expect(mockClient.calls[0]?.signalName).toBe("priceCheck");

    priceFeed.end();
    await subscribePromise.catch(() => {
      // Expected: StopRequestedError once the feed terminates.
    });
  }, 10_000);

  test("TRACKING setup: signals 'trackingPrice' on every tick", async () => {
    await setupRepo.create({
      id: "setup-2",
      watchId: "btc-1h",
      asset: "BTCUSDT",
      timeframe: "1h",
      status: "TRACKING",
      currentScore: 85,
      patternHint: "double_bottom",
      invalidationLevel: 41500,
      direction: "LONG",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86400_000),
      workflowId: "setup-wf-2",
    });

    const subscribePromise = activities.subscribeAndCheckPriceFeed({
      watchId: "btc-1h",
      adapter: "fake",
      assets: ["BTCUSDT"],
    });

    // First tick -- should signal trackingPrice (no breach filter for TRACKING).
    priceFeed.emit({ asset: "BTCUSDT", price: 42000, timestamp: new Date() });
    await Bun.sleep(50);
    expect(mockClient.calls.length).toBe(1);
    expect(mockClient.calls[0]?.signalName).toBe("trackingPrice");
    expect(mockClient.calls[0]?.workflowId).toBe("setup-wf-2");

    // Second tick -- should also signal trackingPrice.
    priceFeed.emit({ asset: "BTCUSDT", price: 42100, timestamp: new Date() });
    await Bun.sleep(50);
    expect(mockClient.calls.length).toBe(2);
    expect(mockClient.calls[1]?.signalName).toBe("trackingPrice");

    priceFeed.end();
    await subscribePromise.catch(() => {
      // Expected: StopRequestedError once the feed terminates.
    });
  }, 10_000);
});
