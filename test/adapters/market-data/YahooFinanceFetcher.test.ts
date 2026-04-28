import { describe, expect, test } from "bun:test";
import { YahooFinanceFetcher } from "@adapters/market-data/YahooFinanceFetcher";

describe("YahooFinanceFetcher", () => {
  const fetcher = new YahooFinanceFetcher({});

  test("fetches AAPL daily candles", async () => {
    const candles = await fetcher.fetchOHLCV({ asset: "AAPL", timeframe: "1d", limit: 30 });
    expect(candles.length).toBeGreaterThan(0);
    expect(candles.length).toBeLessThanOrEqual(30);
    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(c.low);
    }
  }, 15_000);

  test("isAssetSupported(AAPL) returns true", async () => {
    expect(await fetcher.isAssetSupported("AAPL")).toBe(true);
  }, 15_000);

  test("isAssetSupported(GHOST_TICKER_XYZ123) returns false", async () => {
    expect(await fetcher.isAssetSupported("GHOST_TICKER_XYZ123")).toBe(false);
  }, 15_000);
});
