import { beforeEach, describe, expect, mock, test } from "bun:test";
import { lookupYahooMetadata } from "@client/lib/yahooMetadata";

const originalFetch = globalThis.fetch;

function mockFetch(payload: unknown, ok = true, status = 200) {
  const response = mock(async () => ({ ok, status, json: async () => payload }));
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  globalThis.fetch = response as any;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

describe("lookupYahooMetadata", () => {
  test("exact match returns quoteType + raw exchange code", async () => {
    mockFetch({
      quotes: [
        { symbol: "AAPL", quoteType: "EQUITY", exchange: "NMS", exchDisp: "NASDAQ" },
        { symbol: "AAPL.MX", quoteType: "EQUITY", exchange: "MEX" },
      ],
    });
    const m = await lookupYahooMetadata("AAPL");
    expect(m).toEqual({ quoteType: "EQUITY", exchange: "NMS" });
  });

  test("CURRENCY without exchange is OK (exchange undefined)", async () => {
    mockFetch({
      quotes: [{ symbol: "EURUSD=X", quoteType: "CURRENCY" }],
    });
    const m = await lookupYahooMetadata("EURUSD=X");
    expect(m).toEqual({ quoteType: "CURRENCY", exchange: undefined });
  });

  test("symbol not in results → null", async () => {
    mockFetch({ quotes: [{ symbol: "OTHER", quoteType: "EQUITY", exchange: "NMS" }] });
    expect(await lookupYahooMetadata("AAPL")).toBeNull();
  });

  test("empty quotes → null", async () => {
    mockFetch({ quotes: [] });
    expect(await lookupYahooMetadata("AAPL")).toBeNull();
  });

  test("unsupported quoteType (e.g. MUTUALFUND) → null", async () => {
    mockFetch({ quotes: [{ symbol: "VFIAX", quoteType: "MUTUALFUND" }] });
    expect(await lookupYahooMetadata("VFIAX")).toBeNull();
  });

  test("HTTP error → null", async () => {
    mockFetch({}, false, 500);
    expect(await lookupYahooMetadata("AAPL")).toBeNull();
  });

  test("fetch throws → null (returns silently for caller to 422)", async () => {
    const thrower = mock(async () => {
      throw new Error("network down");
    });
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    globalThis.fetch = thrower as any;
    expect(await lookupYahooMetadata("AAPL")).toBeNull();
  });
});
