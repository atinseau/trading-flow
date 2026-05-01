import { describe, expect, test } from "bun:test";
import { TickSnapshotsContextProvider } from "@adapters/feedback-context/TickSnapshotsContextProvider";
import type { FeedbackContextScope } from "@domain/ports/FeedbackContextProvider";
import { NEUTRAL_INDICATORS } from "../../fakes/FakeIndicatorCalculator";
import { InMemoryTickSnapshotStore } from "../../fakes/InMemoryTickSnapshotStore";

const scope: FeedbackContextScope = {
  setupId: "11111111-1111-1111-1111-111111111111",
  watchId: "btc-1h",
  asset: "BTCUSDT",
  timeframe: "1h",
  closeOutcome: { reason: "sl_hit_direct", everConfirmed: true },
  setupCreatedAt: new Date("2026-04-29T10:00:00Z"),
  setupClosedAt: new Date("2026-04-29T14:00:00Z"),
  confirmedAt: new Date("2026-04-29T12:00:00Z"),
};

const baseIndicators = {
  ...NEUTRAL_INDICATORS,
  rsi: 42.5,
  emaShort: 42100,
  emaMid: 42050,
  emaLong: 41800,
  atr: 250,
  atrMa20: 240,
  volumeMa20: 1000,
  lastVolume: 1234,
  recentHigh: 42500,
  recentLow: 41700,
};

describe("TickSnapshotsContextProvider", () => {
  test("renders markdown table of indicators per tick", async () => {
    const tickStore = new InMemoryTickSnapshotStore();
    const tick = await tickStore.create({
      watchId: scope.watchId,
      tickAt: new Date("2026-04-29T11:00:00Z"),
      asset: scope.asset,
      timeframe: scope.timeframe,
      ohlcvUri: "file:///x.csv",
      chartUri: "file:///y.png",
      indicators: baseIndicators,
      lastClose: null,
      preFilterPass: true,
    });
    expect(tick.id).toBeDefined();
    const provider = new TickSnapshotsContextProvider({ tickStore });
    expect(provider.id).toBe("tick-snapshots");
    const chunks = await provider.gather(scope);
    expect(chunks).toHaveLength(1);
    if (chunks[0]?.content.kind === "markdown") {
      expect(chunks[0].content.value).toContain("rsi");
      expect(chunks[0].content.value).toContain("42.5");
    }
  });

  test("filters ticks outside the setup window", async () => {
    const tickStore = new InMemoryTickSnapshotStore();
    await tickStore.create({
      watchId: scope.watchId,
      tickAt: new Date("2026-04-29T08:00:00Z"), // before
      asset: scope.asset,
      timeframe: scope.timeframe,
      ohlcvUri: "file:///x.csv",
      chartUri: "file:///y.png",
      indicators: { ...baseIndicators, rsi: 99 },
      lastClose: null,
      preFilterPass: true,
    });
    await tickStore.create({
      watchId: scope.watchId,
      tickAt: new Date("2026-04-29T11:00:00Z"), // inside
      asset: scope.asset,
      timeframe: scope.timeframe,
      ohlcvUri: "file:///x.csv",
      chartUri: "file:///y.png",
      indicators: { ...baseIndicators, rsi: 50 },
      lastClose: null,
      preFilterPass: true,
    });
    const provider = new TickSnapshotsContextProvider({ tickStore });
    const chunks = await provider.gather(scope);
    if (chunks[0]?.content.kind === "markdown") {
      expect(chunks[0].content.value).toContain("| 50 |");
      expect(chunks[0].content.value).not.toContain("| 99 |");
    }
  });
});
