import { ensureHappyDom } from "../setup";

ensureHappyDom();

import { describe, expect, test } from "bun:test";
import { useMarketSession } from "@client/hooks/useMarketSession";
import { renderHook } from "@testing-library/react";

describe("useMarketSession", () => {
  test("returns always-open session for binance watch", () => {
    const { result } = renderHook(() =>
      useMarketSession({
        asset: { source: "binance", symbol: "BTCUSDT" },
      }),
    );
    expect(result.current.session?.kind).toBe("always-open");
    expect(result.current.state?.isOpen).toBe(true);
  });

  test("returns exchange session for yahoo EQUITY", () => {
    const { result } = renderHook(() =>
      useMarketSession({
        asset: {
          source: "yahoo",
          symbol: "AAPL",
          quoteType: "EQUITY",
          exchange: "NMS",
        },
      }),
    );
    expect(result.current.session?.kind).toBe("exchange");
  });

  test("returns null session for invalid watch (unknown exchange)", () => {
    const { result } = renderHook(() =>
      useMarketSession({
        asset: {
          source: "yahoo",
          symbol: "FOO",
          quoteType: "EQUITY",
          exchange: "XYZ", // not in normalize map
        },
      }),
    );
    expect(result.current.session).toBeNull();
    expect(result.current.state).toBeNull();
  });
});
