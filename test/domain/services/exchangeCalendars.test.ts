import { describe, expect, test } from "bun:test";
import { EXCHANGE_DEFS, normalizeYahooExchange } from "@domain/services/exchangeCalendars";

describe("normalizeYahooExchange", () => {
  test("maps NASDAQ codes (NMS, NCM, NGM) → NASDAQ", () => {
    expect(normalizeYahooExchange("NMS")).toBe("NASDAQ");
    expect(normalizeYahooExchange("NCM")).toBe("NASDAQ");
    expect(normalizeYahooExchange("NGM")).toBe("NASDAQ");
  });
  test("maps NYQ → NYSE", () => expect(normalizeYahooExchange("NYQ")).toBe("NYSE"));
  test("maps PAR → PAR", () => expect(normalizeYahooExchange("PAR")).toBe("PAR"));
  test("maps JPX → TSE", () => expect(normalizeYahooExchange("JPX")).toBe("TSE"));
  test("maps HKG → HKEX", () => expect(normalizeYahooExchange("HKG")).toBe("HKEX"));
  test("returns null for unknown code", () => expect(normalizeYahooExchange("XYZ")).toBeNull());
  test("returns null for undefined", () => expect(normalizeYahooExchange(undefined)).toBeNull());
});

describe("EXCHANGE_DEFS", () => {
  test("US exchanges share NY tz and 09:30–16:00 hours", () => {
    for (const id of ["NASDAQ", "NYSE", "AMEX", "ARCA"] as const) {
      expect(EXCHANGE_DEFS[id].tz).toBe("America/New_York");
      expect(EXCHANGE_DEFS[id].ranges).toEqual([{ open: "09:30", close: "16:00" }]);
    }
  });
  test("Tokyo has lunch break (two ranges)", () => {
    expect(EXCHANGE_DEFS.TSE.ranges).toEqual([
      { open: "09:00", close: "11:30" },
      { open: "12:30", close: "15:00" },
    ]);
  });
  test("HKEX has lunch break (two ranges)", () => {
    expect(EXCHANGE_DEFS.HKEX.ranges).toEqual([
      { open: "09:30", close: "12:00" },
      { open: "13:00", close: "16:00" },
    ]);
  });
});
