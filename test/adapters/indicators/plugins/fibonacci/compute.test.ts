import { describe, expect, test } from "bun:test";
import { computeAnchor, fibLevels } from "@adapters/indicators/plugins/fibonacci/compute";

describe("fibLevels math", () => {
  test("uptrend: 0.618 below high, 1.272 above high", () => {
    const anchor = { high: 110, low: 100, highIdx: 50, lowIdx: 30, direction: "uptrend" as const };
    const lv = fibLevels(anchor);
    expect(lv.fib_0_382).toBeCloseTo(110 - 3.82);
    expect(lv.fib_0_500).toBeCloseTo(105);
    expect(lv.fib_0_618).toBeCloseTo(110 - 6.18);
    expect(lv.fib_1_272).toBeCloseTo(110 + 2.72);
    expect(lv.fib_1_618).toBeCloseTo(110 + 6.18);
  });

  test("downtrend: 0.618 above low, 1.272 below low", () => {
    const anchor = {
      high: 110,
      low: 100,
      highIdx: 30,
      lowIdx: 50,
      direction: "downtrend" as const,
    };
    const lv = fibLevels(anchor);
    expect(lv.fib_0_382).toBeCloseTo(100 + 3.82);
    expect(lv.fib_0_618).toBeCloseTo(100 + 6.18);
    expect(lv.fib_1_272).toBeCloseTo(100 - 2.72);
    expect(lv.fib_1_618).toBeCloseTo(100 - 6.18);
  });
});

function makeCandles(): { high: number; low: number }[] {
  const arr: { high: number; low: number }[] = [];
  // Descent to trough at i=8 (low=91), then rally to peak at i=16 (high=108).
  for (let i = 0; i < 8; i++) arr.push({ high: 100 - i, low: 99 - i });
  arr.push({ high: 92.5, low: 91 });
  // Rally
  for (let i = 0; i < 7; i++) arr.push({ high: 93 + i * 2, low: 92 + i * 0.8 });
  // Peak (i=16)
  arr.push({ high: 108, low: 100 });
  // Pull-back with rising lows so no new swing low forms
  for (let i = 0; i < 5; i++) arr.push({ high: 106 - i, low: 100.5 + i * 0.2 });
  return arr;
}

describe("computeAnchor", () => {
  test("returns null when series too short", () => {
    const tiny = Array.from({ length: 5 }, (_, i) => ({ high: 100.5 - i, low: 99.5 - i }));
    const a = computeAnchor(
      tiny.map((c) => c.high),
      tiny.map((c) => c.low),
      3,
    );
    expect(a).toBeNull();
  });

  test("uptrend series yields uptrend anchor with high > low", () => {
    const c = makeCandles();
    const a = computeAnchor(
      c.map((x) => x.high),
      c.map((x) => x.low),
      3,
    );
    expect(a).not.toBeNull();
    if (a) {
      expect(a.direction).toBe("uptrend");
      expect(a.high).toBeGreaterThan(a.low);
    }
  });
});
