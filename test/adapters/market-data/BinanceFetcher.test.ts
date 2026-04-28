import { describe, expect, test } from "bun:test";
import { BinanceFetcher } from "@adapters/market-data/BinanceFetcher";

describe("BinanceFetcher", () => {
  const fetcher = new BinanceFetcher({});

  test("fetches BTCUSDT 1h with limit 50", async () => {
    const candles = await fetcher.fetchOHLCV({ asset: "BTCUSDT", timeframe: "1h", limit: 50 });
    expect(candles).toHaveLength(50);
    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(c.low);
      expect(c.high).toBeGreaterThanOrEqual(c.open);
      expect(c.high).toBeGreaterThanOrEqual(c.close);
      expect(c.low).toBeLessThanOrEqual(c.open);
      expect(c.volume).toBeGreaterThanOrEqual(0);
    }
  }, 15_000);

  test("isAssetSupported returns true for BTCUSDT", async () => {
    expect(await fetcher.isAssetSupported("BTCUSDT")).toBe(true);
  }, 15_000);

  test("isAssetSupported returns false for fake symbol", async () => {
    expect(await fetcher.isAssetSupported("FAKE_SYMBOL_XYZ")).toBe(false);
  }, 15_000);
});
