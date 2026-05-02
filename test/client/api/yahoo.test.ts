import { beforeEach, describe, expect, mock, test } from "bun:test";
import { yahooLookup } from "@client/api/yahoo";

const originalFetch = globalThis.fetch;

function mockYahoo(payload: unknown, ok = true, status = 200) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  globalThis.fetch = mock(async () => ({ ok, status, json: async () => payload })) as any;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

const GET = (qs: string) => new Request(`http://x/api/yahoo/lookup${qs}`);

describe("GET /api/yahoo/lookup", () => {
  test("returns metadata for a known equity symbol", async () => {
    mockYahoo({ quotes: [{ symbol: "AAPL", quoteType: "EQUITY", exchange: "NMS" }] });
    const res = await yahooLookup(GET("?symbol=AAPL"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quoteType: "EQUITY", exchange: "NMS" });
  });

  test("returns CURRENCY metadata without exchange", async () => {
    mockYahoo({ quotes: [{ symbol: "EURUSD=X", quoteType: "CURRENCY" }] });
    const res = await yahooLookup(GET("?symbol=EURUSD%3DX"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quoteType: "CURRENCY" });
  });

  test("404 when symbol unknown to Yahoo", async () => {
    mockYahoo({ quotes: [] });
    const res = await yahooLookup(GET("?symbol=NOPE"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "yahoo asset not found: NOPE" });
  });

  test("400 when symbol query param is missing", async () => {
    const res = await yahooLookup(GET(""));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing query param: symbol" });
  });
});
