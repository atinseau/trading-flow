import { describe, expect, test } from "bun:test";
import { computeTtlExpiresAt } from "@domain/pipeline/computeTtlExpiresAt";

describe("computeTtlExpiresAt", () => {
  const base = new Date("2026-05-14T10:00:00.000Z");

  test("1m × 50 candles = 50 min", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: base,
      ttlCandles: 50,
      primaryTimeframe: "1m",
    });
    expect(out.toISOString()).toBe("2026-05-14T10:50:00.000Z");
  });

  test("15m × 50 candles = 12h30 (NOT 50h — was the live bug)", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: base,
      ttlCandles: 50,
      primaryTimeframe: "15m",
    });
    expect(out.toISOString()).toBe("2026-05-14T22:30:00.000Z");
  });

  test("1h × 50 candles = 50h", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: base,
      ttlCandles: 50,
      primaryTimeframe: "1h",
    });
    expect(out.toISOString()).toBe("2026-05-16T12:00:00.000Z");
  });

  test("4h × 10 candles = 40h", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: base,
      ttlCandles: 10,
      primaryTimeframe: "4h",
    });
    expect(out.toISOString()).toBe("2026-05-16T02:00:00.000Z");
  });

  test("1d × 5 candles = 5 days", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: base,
      ttlCandles: 5,
      primaryTimeframe: "1d",
    });
    expect(out.toISOString()).toBe("2026-05-19T10:00:00.000Z");
  });

  test("accepts ISO string input", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: "2026-05-14T10:00:00.000Z",
      ttlCandles: 4,
      primaryTimeframe: "15m",
    });
    expect(out.toISOString()).toBe("2026-05-14T11:00:00.000Z");
  });
});
