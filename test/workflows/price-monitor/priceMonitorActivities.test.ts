import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SystemClock } from "@adapters/time/SystemClock";
import { FakeClock } from "@test-fakes/FakeClock";
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

    // Binance watch — always-open session, so the market-hours guard never blocks.
    const fakeWatch = { id: "btc-1h", asset: { source: "binance", symbol: "BTCUSDT" } };

    const deps = {
      setupRepo,
      priceFeeds: new Map([["fake", priceFeed]]),
      temporalClient: mockClient.client,
      clock: new SystemClock(),
      watchById: async (_id: string) => fakeWatch,
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

describe("priceMonitor activity market-hours gate", () => {
  afterEach(() => {
    // nothing shared — each test creates its own feed
  });

  test("skips emission when market is closed (NASDAQ Saturday)", async () => {
    // Saturday 2026-04-25 12:00 UTC — NASDAQ is closed on weekends.
    const clock = new FakeClock(new Date("2026-04-25T12:00:00Z"));
    const priceFeed = new FakePriceFeed();
    const setupRepo = new InMemorySetupRepository();
    const mockClient = makeMockTemporalClient();

    await setupRepo.create({
      id: "setup-nasdaq-closed",
      watchId: "aapl-1h",
      asset: "AAPL",
      timeframe: "1h",
      status: "TRACKING",
      currentScore: 80,
      patternHint: "double_bottom",
      invalidationLevel: 170,
      direction: "LONG",
      ttlCandles: 50,
      ttlExpiresAt: new Date(Date.now() + 86400_000),
      workflowId: "setup-wf-nasdaq",
    });

    // Watch on yahoo EQUITY NASDAQ
    const fakeWatch = {
      id: "aapl-1h",
      asset: { source: "yahoo", symbol: "AAPL", quoteType: "EQUITY", exchange: "NMS" },
    };

    const deps = {
      setupRepo,
      priceFeeds: new Map([["fake", priceFeed]]),
      temporalClient: mockClient.client,
      clock,
      watchById: async (_id: string) => fakeWatch,
    } as unknown as ActivityDeps;

    const activities = buildPriceMonitorActivities(deps);

    const subscribePromise = activities.subscribeAndCheckPriceFeed({
      watchId: "aapl-1h",
      adapter: "fake",
      assets: ["AAPL"],
    });

    // Emit a tick — market is closed, so no signal should be emitted.
    priceFeed.emit({ asset: "AAPL", price: 175, timestamp: new Date() });
    await Bun.sleep(50);
    expect(mockClient.calls.length).toBe(0);

    priceFeed.end();
    await subscribePromise.catch(() => {
      // Expected: StopRequestedError once the feed terminates.
    });
  }, 10_000);

  test("emits when market is open (Binance always-open)", async () => {
    // Any time — Binance is 24/7.
    const clock = new FakeClock(new Date("2026-04-25T12:00:00Z"));
    const priceFeed = new FakePriceFeed();
    const setupRepo = new InMemorySetupRepository();
    const mockClient = makeMockTemporalClient();

    await setupRepo.create({
      id: "setup-binance-open",
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
      workflowId: "setup-wf-binance",
    });

    // Watch on binance (always-open session)
    const fakeWatch = {
      id: "btc-1h",
      asset: { source: "binance", symbol: "BTCUSDT" },
    };

    const deps = {
      setupRepo,
      priceFeeds: new Map([["fake", priceFeed]]),
      temporalClient: mockClient.client,
      clock,
      watchById: async (_id: string) => fakeWatch,
    } as unknown as ActivityDeps;

    const activities = buildPriceMonitorActivities(deps);

    const subscribePromise = activities.subscribeAndCheckPriceFeed({
      watchId: "btc-1h",
      adapter: "fake",
      assets: ["BTCUSDT"],
    });

    // Emit a tick — Binance is always open, so signal should be emitted.
    priceFeed.emit({ asset: "BTCUSDT", price: 42000, timestamp: new Date() });
    await Bun.sleep(50);
    expect(mockClient.calls.length).toBe(1);
    expect(mockClient.calls[0]?.signalName).toBe("trackingPrice");
    expect(mockClient.calls[0]?.workflowId).toBe("setup-wf-binance");

    priceFeed.end();
    await subscribePromise.catch(() => {
      // Expected: StopRequestedError once the feed terminates.
    });
  }, 10_000);
});
