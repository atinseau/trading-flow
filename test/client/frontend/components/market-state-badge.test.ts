import { describe, expect, test } from "bun:test";
import { formatRelativeOpening } from "@client/components/market-state-badge";

describe("formatRelativeOpening", () => {
  const now = new Date("2026-04-29T12:00:00Z"); // Wed

  test("< 60 min: 'dans X min'", () => {
    const target = new Date(now.getTime() + 45 * 60_000);
    expect(formatRelativeOpening(target, now)).toBe("dans 45 min");
  });

  test("< 24h: 'dans XhMM'", () => {
    const target = new Date(now.getTime() + 8 * 3600_000 + 12 * 60_000);
    expect(formatRelativeOpening(target, now)).toBe("dans 8h12");
  });

  test("same week: 'lundi à HH:MM'", () => {
    // 2026-05-04 is a Monday at 15:30 UTC
    const target = new Date("2026-05-04T15:30:00Z");
    const result = formatRelativeOpening(target, now);
    expect(result).toMatch(/lundi/);
    expect(result).toMatch(/15:30|17:30/); // matches both UTC and Paris (locale-dep)
  });

  test("past or now: 'maintenant'", () => {
    const target = new Date(now.getTime() - 1000);
    expect(formatRelativeOpening(target, now)).toBe("maintenant");
  });
});
