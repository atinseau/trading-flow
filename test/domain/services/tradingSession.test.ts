import { describe, expect, test } from "bun:test";
import { getTradingSession } from "@domain/services/tradingSession";

describe("getTradingSession", () => {
  test("classifies London-NY overlap (12-16 UTC weekday)", () => {
    expect(getTradingSession(new Date("2026-04-29T13:00:00Z"))).toBe("london_ny_overlap");
    expect(getTradingSession(new Date("2026-04-29T15:59:00Z"))).toBe("london_ny_overlap");
  });

  test("classifies London (07-12 UTC)", () => {
    expect(getTradingSession(new Date("2026-04-29T08:00:00Z"))).toBe("london");
    expect(getTradingSession(new Date("2026-04-29T11:59:00Z"))).toBe("london");
  });

  test("classifies NY (16-21 UTC)", () => {
    expect(getTradingSession(new Date("2026-04-29T18:00:00Z"))).toBe("ny");
  });

  test("classifies Asian (00-07 UTC)", () => {
    expect(getTradingSession(new Date("2026-04-29T03:00:00Z"))).toBe("asian");
  });

  test("Saturday is off_hours regardless of time", () => {
    expect(getTradingSession(new Date("2026-05-02T13:00:00Z"))).toBe("off_hours");
  });

  test("late evening UTC is off_hours", () => {
    expect(getTradingSession(new Date("2026-04-29T22:30:00Z"))).toBe("off_hours");
  });
});
