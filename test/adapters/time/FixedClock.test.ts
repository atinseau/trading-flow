import { describe, expect, test } from "bun:test";
import { FixedClock } from "@adapters/time/FixedClock";

describe("FixedClock", () => {
  test("now() returns the fixed instant", () => {
    const t = new Date("2026-04-12T14:00:00.000Z");
    const c = new FixedClock(t);
    expect(c.now().toISOString()).toBe(t.toISOString());
  });

  test("now() returns a fresh Date instance (no shared mutation surface)", () => {
    const t = new Date("2026-04-12T14:00:00.000Z");
    const c = new FixedClock(t);
    const first = c.now();
    first.setFullYear(1999);
    expect(c.now().getUTCFullYear()).toBe(2026);
  });

  test("candleDurationMs delegates to parseTimeframeToMs", () => {
    const c = new FixedClock(new Date());
    expect(c.candleDurationMs("1h")).toBe(3_600_000);
    expect(c.candleDurationMs("15m")).toBe(15 * 60_000);
    expect(c.candleDurationMs("1d")).toBe(86_400_000);
  });
});
