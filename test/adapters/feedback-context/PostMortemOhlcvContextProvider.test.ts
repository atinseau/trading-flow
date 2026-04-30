import { describe, expect, test } from "bun:test";
import { PostMortemOhlcvContextProvider } from "@adapters/feedback-context/PostMortemOhlcvContextProvider";
import type { FeedbackContextScope } from "@domain/ports/FeedbackContextProvider";
import { FakeMarketDataFetcher } from "../../fakes/FakeMarketDataFetcher";

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

describe("PostMortemOhlcvContextProvider", () => {
  test("returns markdown table of OHLCV from confirmedAt..closedAt+margin", async () => {
    const fetcher = new FakeMarketDataFetcher();
    fetcher.seed("BTCUSDT", "1h", [
      {
        open: 42100,
        high: 42200,
        low: 41900,
        close: 41950,
        volume: 1234,
        timestamp: new Date("2026-04-29T12:00:00Z"),
      },
      {
        open: 41950,
        high: 42000,
        low: 41700,
        close: 41720,
        volume: 1500,
        timestamp: new Date("2026-04-29T13:00:00Z"),
      },
    ]);
    const provider = new PostMortemOhlcvContextProvider({ marketDataFetcher: fetcher });
    expect(provider.id).toBe("post-mortem-ohlcv");
    expect(provider.isApplicable(scope)).toBe(true);
    const chunks = await provider.gather(scope);
    if (chunks[0]?.content.kind === "markdown") {
      expect(chunks[0].content.value).toContain("41720");
    }
  });

  test("not applicable when confirmedAt is null", async () => {
    const fetcher = new FakeMarketDataFetcher();
    const provider = new PostMortemOhlcvContextProvider({ marketDataFetcher: fetcher });
    expect(provider.isApplicable({ ...scope, confirmedAt: null })).toBe(false);
  });

  test("queries fetcher with confirmedAt as 'from' and closedAt+margin as 'to'", async () => {
    const fetcher = new FakeMarketDataFetcher();
    fetcher.seed("BTCUSDT", "1h", []);
    const provider = new PostMortemOhlcvContextProvider({ marketDataFetcher: fetcher });
    await provider.gather(scope);
    expect(fetcher.rangeCallsLog).toHaveLength(1);
    const call = fetcher.rangeCallsLog[0];
    expect(call?.from.toISOString()).toBe("2026-04-29T12:00:00.000Z");
    expect(call?.to.toISOString()).toBe("2026-04-29T18:00:00.000Z"); // closedAt + 4h
  });
});
