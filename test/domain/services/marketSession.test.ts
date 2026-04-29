import { describe, expect, test } from "bun:test";
import { UnsupportedExchangeError } from "@domain/errors";
import { getSession, getSessionState, type WatchAssetInput } from "@domain/services/marketSession";

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

describe("getSessionState — always-open", () => {
  test("isOpen always true, no nextOpenAt/nextCloseAt", () => {
    const state = getSessionState({ kind: "always-open" }, new Date("2026-04-29T12:00:00Z"));
    expect(state.isOpen).toBe(true);
    expect(state.nextOpenAt).toBeUndefined();
    expect(state.nextCloseAt).toBeUndefined();
  });
});

describe("getSessionState — exchange (single range, US)", () => {
  test("NASDAQ open Mon 14:35 UTC in winter (= 09:35 ET)", () => {
    const state = getSessionState(
      { kind: "exchange", id: "NASDAQ" },
      new Date("2026-01-12T14:35:00Z"),
    );
    expect(state.isOpen).toBe(true);
    expect(state.nextCloseAt).toEqual(new Date("2026-01-12T21:00:00Z")); // 16:00 EST = 21:00 UTC
  });

  test("NASDAQ open Mon 14:35 UTC in summer (= 10:35 EDT)", () => {
    const state = getSessionState(
      { kind: "exchange", id: "NASDAQ" },
      new Date("2026-07-13T14:35:00Z"),
    );
    expect(state.isOpen).toBe(true);
    expect(state.nextCloseAt).toEqual(new Date("2026-07-13T20:00:00Z")); // 16:00 EDT = 20:00 UTC
  });

  test("NASDAQ closed Saturday → next open Mon 09:30 ET", () => {
    const state = getSessionState(
      { kind: "exchange", id: "NASDAQ" },
      new Date("2026-01-10T15:00:00Z"),
    );
    expect(state.isOpen).toBe(false);
    expect(state.nextOpenAt).toEqual(new Date("2026-01-12T14:30:00Z")); // Mon 09:30 EST
  });

  test("NYSE Friday 22:00 UTC → closed → next open Monday 14:30 UTC", () => {
    const state = getSessionState(
      { kind: "exchange", id: "NYSE" },
      new Date("2026-01-09T22:00:00Z"),
    );
    expect(state.isOpen).toBe(false);
    expect(state.nextOpenAt).toEqual(new Date("2026-01-12T14:30:00Z"));
  });

  test("DST transition spring 2026 (Sunday 2026-03-08 ahead): Mon 13:35 UTC = 09:35 EDT", () => {
    const state = getSessionState(
      { kind: "exchange", id: "NYSE" },
      new Date("2026-03-09T13:35:00Z"),
    );
    expect(state.isOpen).toBe(true);
  });
});

describe("getSessionState — exchange (multi-range, Asia)", () => {
  test("Tokyo at 11:45 JST → closed (lunch), next open 12:30 JST", () => {
    // 11:45 JST Mon = 02:45 UTC Mon
    const state = getSessionState(
      { kind: "exchange", id: "TSE" },
      new Date("2026-04-13T02:45:00Z"),
    );
    expect(state.isOpen).toBe(false);
    expect(state.nextOpenAt).toEqual(new Date("2026-04-13T03:30:00Z")); // 12:30 JST = 03:30 UTC
  });

  test("Tokyo at 13:00 JST → open, nextCloseAt 15:00 JST", () => {
    // 13:00 JST Mon = 04:00 UTC Mon
    const state = getSessionState(
      { kind: "exchange", id: "TSE" },
      new Date("2026-04-13T04:00:00Z"),
    );
    expect(state.isOpen).toBe(true);
    expect(state.nextCloseAt).toEqual(new Date("2026-04-13T06:00:00Z")); // 15:00 JST = 06:00 UTC
  });

  test("Tokyo Saturday → closed, next open Mon 09:00 JST", () => {
    // Sat 2026-04-11 04:00 UTC
    const state = getSessionState(
      { kind: "exchange", id: "TSE" },
      new Date("2026-04-11T04:00:00Z"),
    );
    expect(state.isOpen).toBe(false);
    // Mon 2026-04-13 09:00 JST = 00:00 UTC
    expect(state.nextOpenAt).toEqual(new Date("2026-04-13T00:00:00Z"));
  });
});

describe("getSessionState — forex", () => {
  test("Tuesday 10:00 UTC → open", () => {
    const state = getSessionState({ kind: "forex" }, new Date("2026-04-14T10:00:00Z"));
    expect(state.isOpen).toBe(true);
  });

  test("Saturday 10:00 UTC → closed, next open Sunday 17:00 ET (April → EDT, 21:00 UTC)", () => {
    const state = getSessionState({ kind: "forex" }, new Date("2026-04-11T10:00:00Z"));
    expect(state.isOpen).toBe(false);
    expect(state.nextOpenAt).toEqual(new Date("2026-04-12T21:00:00Z"));
  });

  test("Friday 22:00 UTC summer → closed (after 17:00 EDT close at 21:00 UTC)", () => {
    const state = getSessionState({ kind: "forex" }, new Date("2026-04-10T22:00:00Z"));
    expect(state.isOpen).toBe(false);
  });

  test("Sunday 22:30 UTC winter → open (Sunday 17:30 EST = 22:30 UTC)", () => {
    const state = getSessionState({ kind: "forex" }, new Date("2026-01-11T22:30:00Z"));
    expect(state.isOpen).toBe(true);
  });

  test("Wednesday 03:00 UTC summer → open (it's Tue 23:00 EDT, mid-week)", () => {
    const state = getSessionState({ kind: "forex" }, new Date("2026-04-15T03:00:00Z"));
    expect(state.isOpen).toBe(true);
  });

  test("when closed Saturday, nextOpenAt resolves to Sunday 17:00 ET (correct UTC across DST)", () => {
    // Winter: Sun 17:00 EST = 22:00 UTC
    const winter = getSessionState({ kind: "forex" }, new Date("2026-01-10T15:00:00Z"));
    expect(winter.nextOpenAt).toEqual(new Date("2026-01-11T22:00:00Z"));
    // Summer: Sun 17:00 EDT = 21:00 UTC
    const summer = getSessionState({ kind: "forex" }, new Date("2026-07-04T15:00:00Z"));
    expect(summer.nextOpenAt).toEqual(new Date("2026-07-05T21:00:00Z"));
  });

  test("when open Wednesday, nextCloseAt resolves to upcoming Friday 17:00 ET", () => {
    // 2026-04-15 is Wednesday. Friday 2026-04-17 17:00 EDT = 21:00 UTC
    const state = getSessionState({ kind: "forex" }, new Date("2026-04-15T10:00:00Z"));
    expect(state.isOpen).toBe(true);
    expect(state.nextCloseAt).toEqual(new Date("2026-04-17T21:00:00Z"));
  });
});

import { sessionKey, watchesInSession } from "@domain/services/marketSession";

describe("watchesInSession", () => {
  const w = (id: string, asset: object) => ({ id, asset }) as any;
  const aapl = w("watch_aapl", {
    source: "yahoo",
    symbol: "AAPL",
    quoteType: "EQUITY",
    exchange: "NMS",
  });
  const cac = w("watch_cac", {
    source: "yahoo",
    symbol: "^FCHI",
    quoteType: "INDEX",
    exchange: "PAR",
  });
  const eurusd = w("watch_eurusd", { source: "yahoo", symbol: "EURUSD=X", quoteType: "CURRENCY" });
  const btc = w("watch_btc", { source: "binance", symbol: "BTCUSDT" });
  const broken = w("watch_broken", {
    source: "yahoo",
    symbol: "FOO",
    quoteType: "EQUITY",
    exchange: "XYZ",
  });

  test("filters to NASDAQ session", () => {
    expect(watchesInSession([aapl, cac, eurusd, btc], { kind: "exchange", id: "NASDAQ" })).toEqual([
      aapl,
    ]);
  });
  test("filters to forex", () => {
    expect(watchesInSession([aapl, cac, eurusd, btc], { kind: "forex" })).toEqual([eurusd]);
  });
  test("filters to always-open", () => {
    expect(watchesInSession([aapl, cac, eurusd, btc], { kind: "always-open" })).toEqual([btc]);
  });
  test("invalid watches (unknown exchange) are silently excluded", () => {
    expect(watchesInSession([aapl, broken], { kind: "exchange", id: "NASDAQ" })).toEqual([aapl]);
  });
});

describe("sessionKey", () => {
  test("always-open → 'always-open'", () =>
    expect(sessionKey({ kind: "always-open" })).toBe("always-open"));
  test("forex → 'forex'", () => expect(sessionKey({ kind: "forex" })).toBe("forex"));
  test("exchange NASDAQ → 'exchange-NASDAQ'", () =>
    expect(sessionKey({ kind: "exchange", id: "NASDAQ" })).toBe("exchange-NASDAQ"));
  test("exchange PAR → 'exchange-PAR'", () =>
    expect(sessionKey({ kind: "exchange", id: "PAR" })).toBe("exchange-PAR"));
});
