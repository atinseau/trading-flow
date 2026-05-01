import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BinanceFundingRateProvider } from "@adapters/funding/BinanceFundingRateProvider";

/**
 * Mocks `globalThis.fetch` for the four Binance endpoints. Tests cover:
 * - happy path: full snapshot
 * - partial failure: OI endpoints fail, funding rate alone produces a snapshot
 * - missing funding history → null (snapshot useless)
 * - 404 (unsupported symbol) → null, no circuit trip
 * - 429 (rate limit) → null AND circuit opens
 * - circuit open behavior (subsequent calls skip fetch entirely)
 */

let originalFetch: typeof globalThis.fetch;
let calls: { url: string; status: number }[] = [];
let responseQueue: Array<{ url: string | RegExp; status: number; body?: unknown }> = [];

function mockFetch(): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = responseQueue.find((r) =>
      typeof r.url === "string" ? url.includes(r.url) : r.url.test(url),
    );
    if (!match) {
      throw new Error(`unmocked fetch ${url}`);
    }
    calls.push({ url, status: match.status });
    return {
      ok: match.status >= 200 && match.status < 300,
      status: match.status,
      json: async () => match.body,
    } as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  mockFetch();
  calls = [];
  responseQueue = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("BinanceFundingRateProvider", () => {
  test("happy path returns a complete snapshot", async () => {
    responseQueue = [
      {
        url: "fapi/v1/fundingRate",
        status: 200,
        body: [
          { fundingRate: "0.0001", fundingTime: 1700_000_000_000 },
          { fundingRate: "0.0002", fundingTime: 1700_028_800_000 },
        ],
      },
      {
        url: "fapi/v1/premiumIndex",
        status: 200,
        body: { nextFundingTime: 1700_057_600_000 },
      },
      {
        url: "fapi/v1/openInterest",
        status: 200,
        body: { openInterest: "12345.678" },
      },
      {
        url: "openInterestHist",
        status: 200,
        body: [
          { sumOpenInterest: "12000.0", timestamp: 1699_900_000_000 },
          { sumOpenInterest: "12345.0", timestamp: 1699_995_000_000 },
        ],
      },
    ];
    const provider = new BinanceFundingRateProvider();
    const snap = await provider.fetchSnapshot("BTCUSDT");
    expect(snap).not.toBeNull();
    if (!snap) return;
    expect(snap.lastFundingRatePct).toBeCloseTo(0.02, 4); // 0.0002 × 100
    expect(snap.openInterest).toBeCloseTo(12345.678, 3);
    expect(snap.openInterest24hDeltaPct).toBeCloseTo(((12345.678 - 12000) / 12000) * 100, 2);
  });

  test("partial OI failure does not nullify snapshot — funding alone is enough", async () => {
    responseQueue = [
      {
        url: "fapi/v1/fundingRate",
        status: 200,
        body: [{ fundingRate: "0.0001", fundingTime: 1700_000_000_000 }],
      },
      { url: "fapi/v1/premiumIndex", status: 500 },
      { url: "fapi/v1/openInterest", status: 503 },
      { url: "openInterestHist", status: 503 },
    ];
    const snap = await new BinanceFundingRateProvider().fetchSnapshot("BTCUSDT");
    expect(snap).not.toBeNull();
    if (!snap) return;
    expect(snap.lastFundingRatePct).toBeCloseTo(0.01, 4);
    expect(snap.openInterest).toBe(0);
    expect(snap.openInterest24hDeltaPct).toBe(0);
  });

  test("missing funding history → null (no minimum viable signal)", async () => {
    responseQueue = [
      { url: "fapi/v1/fundingRate", status: 500 },
      { url: "fapi/v1/premiumIndex", status: 200, body: { nextFundingTime: 0 } },
      { url: "fapi/v1/openInterest", status: 200, body: { openInterest: "0" } },
      { url: "openInterestHist", status: 200, body: [] },
    ];
    const snap = await new BinanceFundingRateProvider().fetchSnapshot("BTCUSDT");
    expect(snap).toBeNull();
  });

  test("404 (unsupported symbol) returns null without tripping circuit", async () => {
    responseQueue = [
      { url: "fapi/v1/fundingRate", status: 404 },
      { url: "fapi/v1/premiumIndex", status: 404 },
      { url: "fapi/v1/openInterest", status: 404 },
      { url: "openInterestHist", status: 404 },
    ];
    const provider = new BinanceFundingRateProvider();
    const snap = await provider.fetchSnapshot("WEIRDPAIR");
    expect(snap).toBeNull();
    // Should NOT have opened the circuit on 404s.
    // Validate by allowing a second attempt: if circuit is open, calls would be 0.
    calls = [];
    responseQueue = [
      {
        url: "fapi/v1/fundingRate",
        status: 200,
        body: [{ fundingRate: "0.0001", fundingTime: 0 }],
      },
      { url: "fapi/v1/premiumIndex", status: 200, body: { nextFundingTime: 0 } },
      { url: "fapi/v1/openInterest", status: 200, body: { openInterest: "1" } },
      { url: "openInterestHist", status: 200, body: [{ sumOpenInterest: "1", timestamp: 0 }] },
    ];
    const snap2 = await provider.fetchSnapshot("WEIRDPAIR");
    expect(snap2).not.toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  test("429 trips circuit immediately, subsequent fetches skip the network", async () => {
    responseQueue = [
      { url: "fapi/v1/fundingRate", status: 429 },
      { url: "fapi/v1/premiumIndex", status: 429 },
      { url: "fapi/v1/openInterest", status: 429 },
      { url: "openInterestHist", status: 429 },
    ];
    const provider = new BinanceFundingRateProvider();
    const snap1 = await provider.fetchSnapshot("BTCUSDT");
    expect(snap1).toBeNull();

    // Circuit should be open now — second call must NOT hit the network.
    calls = [];
    responseQueue = []; // would throw "unmocked fetch" if any call leaks
    const snap2 = await provider.fetchSnapshot("BTCUSDT");
    expect(snap2).toBeNull();
    expect(calls.length).toBe(0);
  });
});
