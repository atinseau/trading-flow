import { describe, expect, test } from "bun:test";
import { UnsupportedExchangeError } from "@domain/errors";
import { getSession, type WatchAssetInput } from "@domain/services/marketSession";

const baseWatch = (asset: WatchAssetInput["asset"]): WatchAssetInput => ({ asset });

describe("getSession", () => {
  test("binance source → always-open", () => {
    expect(getSession(baseWatch({ source: "binance", symbol: "BTCUSDT" }))).toEqual({
      kind: "always-open",
    });
  });
  test("yahoo CRYPTOCURRENCY → always-open", () => {
    expect(
      getSession(baseWatch({ source: "yahoo", symbol: "BTC-USD", quoteType: "CRYPTOCURRENCY" })),
    ).toEqual({ kind: "always-open" });
  });
  test("yahoo FUTURE → always-open", () => {
    expect(getSession(baseWatch({ source: "yahoo", symbol: "ES=F", quoteType: "FUTURE" }))).toEqual(
      { kind: "always-open" },
    );
  });
  test("yahoo CURRENCY → forex", () => {
    expect(
      getSession(baseWatch({ source: "yahoo", symbol: "EURUSD=X", quoteType: "CURRENCY" })),
    ).toEqual({ kind: "forex" });
  });
  test("yahoo EQUITY NMS → exchange NASDAQ", () => {
    expect(
      getSession(
        baseWatch({
          source: "yahoo",
          symbol: "AAPL",
          quoteType: "EQUITY",
          exchange: "NMS",
        }),
      ),
    ).toEqual({ kind: "exchange", id: "NASDAQ" });
  });
  test("yahoo INDEX PAR → exchange PAR", () => {
    expect(
      getSession(
        baseWatch({
          source: "yahoo",
          symbol: "^FCHI",
          quoteType: "INDEX",
          exchange: "PAR",
        }),
      ),
    ).toEqual({ kind: "exchange", id: "PAR" });
  });
  test("yahoo ETF NMS → exchange NASDAQ", () => {
    expect(
      getSession(
        baseWatch({
          source: "yahoo",
          symbol: "QQQ",
          quoteType: "ETF",
          exchange: "NMS",
        }),
      ),
    ).toEqual({ kind: "exchange", id: "NASDAQ" });
  });
  test("yahoo EQUITY unknown exchange → throws UnsupportedExchangeError", () => {
    expect(() =>
      getSession(
        baseWatch({
          source: "yahoo",
          symbol: "FOO",
          quoteType: "EQUITY",
          exchange: "XYZ",
        }),
      ),
    ).toThrow(UnsupportedExchangeError);
  });
});
