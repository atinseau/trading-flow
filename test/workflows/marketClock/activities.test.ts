import { describe, expect, test } from "bun:test";
import { FakeClock } from "@test-fakes/FakeClock";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { buildMarketClockActivities } from "@workflows/marketClock/activities";

function makeDeps(overrides: {
  watches?: Array<{
    id: string;
    asset: {
      source: string;
      symbol: string;
      quoteType?: string;
      exchange?: string;
    };
    enabled?: boolean;
  }>;
  pauseCalls?: Array<{ id: string; reason: string }>;
  unpauseCalls?: string[];
  clockNow?: Date;
}): ActivityDeps {
  const watches = overrides.watches ?? [];
  const pauseCalls = overrides.pauseCalls ?? [];
  const unpauseCalls = overrides.unpauseCalls ?? [];
  const clock = new FakeClock(overrides.clockNow ?? new Date("2026-04-29T12:00:00Z"));
  return {
    clock,
    watchRepo: {
      findAll: async () => watches as never,
      findById: async () => null,
      findEnabled: async () => watches.filter((w) => w.enabled !== false) as never,
      findAllWithValidation: async () => [],
    },
    scheduleController: {
      pause: async (id: string, reason: string) => {
        pauseCalls.push({ id, reason });
      },
      unpause: async (id: string) => {
        unpauseCalls.push(id);
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal deps for activity test
  } as any;
}

describe("buildMarketClockActivities", () => {
  test("getNow delegates to clock", async () => {
    const t = new Date("2026-04-29T12:00:00Z");
    const acts = buildMarketClockActivities(makeDeps({ clockNow: t }));
    expect(await acts.getNow()).toEqual(t);
  });

  test("listWatchesInSession filters watches by session, returns ids only", async () => {
    const acts = buildMarketClockActivities(
      makeDeps({
        watches: [
          {
            id: "btc",
            asset: { source: "binance", symbol: "BTCUSDT" },
            enabled: true,
          },
          {
            id: "aapl",
            asset: {
              source: "yahoo",
              symbol: "AAPL",
              quoteType: "EQUITY",
              exchange: "NMS",
            },
            enabled: true,
          },
          {
            id: "msft",
            asset: {
              source: "yahoo",
              symbol: "MSFT",
              quoteType: "EQUITY",
              exchange: "NMS",
            },
            enabled: true,
          },
        ],
      }),
    );
    const result = await acts.listWatchesInSession({ kind: "exchange", id: "NASDAQ" });
    expect(result).toEqual([{ id: "aapl" }, { id: "msft" }]);
  });

  test("listWatchesInSession excludes disabled watches", async () => {
    const acts = buildMarketClockActivities(
      makeDeps({
        watches: [
          {
            id: "btc-on",
            asset: { source: "binance", symbol: "BTCUSDT" },
            enabled: true,
          },
          {
            id: "btc-off",
            asset: { source: "binance", symbol: "ETHUSDT" },
            enabled: false,
          },
        ],
      }),
    );
    const result = await acts.listWatchesInSession({ kind: "always-open" });
    expect(result).toEqual([{ id: "btc-on" }]);
  });

  test("applyToSchedules pause forwards each id with reason", async () => {
    const pauseCalls: Array<{ id: string; reason: string }> = [];
    const acts = buildMarketClockActivities(makeDeps({ pauseCalls }));
    await acts.applyToSchedules({
      ids: ["tick-aapl", "tick-msft"],
      action: "pause",
      reason: "market closed",
    });
    expect(pauseCalls).toEqual([
      { id: "tick-aapl", reason: "market closed" },
      { id: "tick-msft", reason: "market closed" },
    ]);
  });

  test("applyToSchedules unpause forwards each id", async () => {
    const unpauseCalls: string[] = [];
    const acts = buildMarketClockActivities(makeDeps({ unpauseCalls }));
    await acts.applyToSchedules({
      ids: ["tick-aapl", "tick-msft"],
      action: "unpause",
      reason: "market open",
    });
    expect(unpauseCalls).toEqual(["tick-aapl", "tick-msft"]);
  });
});
