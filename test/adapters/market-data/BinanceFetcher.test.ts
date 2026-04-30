import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BinanceFetcher } from "@adapters/market-data/BinanceFetcher";

describe("BinanceFetcher", () => {
  const fetcher = new BinanceFetcher();

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

  test("constructs with no args", () => {
    const f = new BinanceFetcher();
    expect(f).toBeDefined();
    expect(f.source).toBe("binance");
  });
});

describe("BinanceFetcher.fetchRange (paginated)", () => {
  const realFetch = globalThis.fetch;

  function makeKlineRow(timestampMs: number): unknown {
    return [
      timestampMs,
      "100.00",
      "101.00",
      "99.00",
      "100.50",
      "12.34",
      timestampMs + 59_999,
      "1234.56",
      10,
      "6.17",
      "617.28",
      "0",
    ];
  }

  function makeBatch(count: number, startMs: number, stepMs: number): unknown[] {
    const rows: unknown[] = [];
    for (let i = 0; i < count; i++) rows.push(makeKlineRow(startMs + i * stepMs));
    return rows;
  }

  beforeEach(() => {
    // Reset between tests so each can install its own stub.
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("paginates: 1000 + 100 candles → returns 1100 total", async () => {
    const stepMs = 60_000; // 1m
    const startMs = Date.UTC(2026, 3, 1, 0, 0, 0);
    const batch1 = makeBatch(1000, startMs, stepMs);
    const lastTs1 = (batch1[batch1.length - 1] as [number])[0];
    const batch2 = makeBatch(100, lastTs1 + 1, stepMs);
    const calls: string[] = [];
    let i = 0;
    globalThis.fetch = (async (url: URL | string) => {
      calls.push(url.toString());
      const body = i === 0 ? batch1 : batch2;
      i++;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const f = new BinanceFetcher();
    const candles = await f.fetchRange({
      asset: "BTCUSDT",
      timeframe: "1m",
      from: new Date(startMs),
      to: new Date(startMs + 2000 * stepMs),
    });
    expect(candles).toHaveLength(1100);
    expect(calls).toHaveLength(2);
    // Second call's startTime must advance past the last ts of batch 1.
    expect(calls[1]).toContain(`startTime=${lastTs1 + 1}`);
  });

  test("returns [] when first batch is empty", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: URL | string) => {
      calls.push(url.toString());
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const f = new BinanceFetcher();
    const startMs = Date.UTC(2026, 3, 1);
    const candles = await f.fetchRange({
      asset: "BTCUSDT",
      timeframe: "1m",
      from: new Date(startMs),
      to: new Date(startMs + 60 * 60 * 1000),
    });
    expect(candles).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  test("stops when batch < 1000 (single short batch)", async () => {
    const stepMs = 60_000;
    const startMs = Date.UTC(2026, 3, 1);
    const batch = makeBatch(42, startMs, stepMs);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(batch), { status: 200 });
    }) as unknown as typeof fetch;

    const f = new BinanceFetcher();
    const candles = await f.fetchRange({
      asset: "BTCUSDT",
      timeframe: "1m",
      from: new Date(startMs),
      to: new Date(startMs + 100 * stepMs),
    });
    expect(candles).toHaveLength(42);
    expect(calls).toBe(1);
  });
});
