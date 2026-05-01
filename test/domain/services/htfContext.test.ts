import { describe, expect, test } from "bun:test";
import type { Candle } from "@domain/schemas/Candle";
import { summarizeHtf } from "@domain/services/htfContext";

function dailyCandle(daysAgo: number, opts: { high: number; low: number; close: number }): Candle {
  return {
    timestamp: new Date(Date.UTC(2026, 3, 30) - daysAgo * 86_400_000),
    open: opts.close,
    high: opts.high,
    low: opts.low,
    close: opts.close,
    volume: 1000,
  };
}

describe("summarizeHtf", () => {
  test("returns neutral defaults on empty daily array", () => {
    const ctx = summarizeHtf([], 75000);
    expect(ctx.daily5).toEqual([]);
    expect(ctx.weeklyHigh).toBe(75000);
    expect(ctx.weeklyLow).toBe(75000);
    expect(ctx.dailyTrend).toBe("sideways");
    expect(ctx.positionInWeeklyRange).toBe(0.5);
  });

  test("uptrend when livePrice > 5d-ago close AND > weekly midpoint", () => {
    // 5d ago closed at 70000; weekly L=68000 H=76000 → mid=72000; live=75000 > 72000 ✓
    const dailies = [
      dailyCandle(7, { high: 71000, low: 68000, close: 70000 }),
      dailyCandle(6, { high: 72000, low: 69000, close: 71000 }),
      dailyCandle(5, { high: 73000, low: 70000, close: 70000 }),
      dailyCandle(4, { high: 74000, low: 71000, close: 73000 }),
      dailyCandle(3, { high: 75000, low: 72000, close: 74000 }),
      dailyCandle(2, { high: 76000, low: 73000, close: 75000 }),
      dailyCandle(1, { high: 76000, low: 74000, close: 75500 }),
    ];
    const ctx = summarizeHtf(dailies, 75000);
    expect(ctx.dailyTrend).toBe("uptrend");
  });

  test("downtrend when livePrice < 5d-ago close AND < weekly midpoint", () => {
    const dailies = [
      dailyCandle(7, { high: 80000, low: 78000, close: 79500 }),
      dailyCandle(6, { high: 79000, low: 76000, close: 77000 }),
      dailyCandle(5, { high: 78000, low: 75000, close: 76000 }),
      dailyCandle(4, { high: 77000, low: 74000, close: 75000 }),
      dailyCandle(3, { high: 76000, low: 73000, close: 74000 }),
      dailyCandle(2, { high: 75000, low: 72000, close: 73000 }),
      dailyCandle(1, { high: 74000, low: 71000, close: 72000 }),
    ];
    const ctx = summarizeHtf(dailies, 71500);
    expect(ctx.dailyTrend).toBe("downtrend");
  });

  test("daily5 contains last 5 days oldest→newest", () => {
    const dailies = Array.from({ length: 10 }, (_, i) =>
      dailyCandle(10 - i, { high: 100 + i, low: 90 + i, close: 95 + i }),
    );
    const ctx = summarizeHtf(dailies, 100);
    expect(ctx.daily5.length).toBe(5);
    // Oldest first → strictly increasing dates.
    for (let i = 1; i < ctx.daily5.length; i++) {
      const prev = ctx.daily5[i - 1];
      const cur = ctx.daily5[i];
      if (!prev || !cur) continue;
      expect(cur.date >= prev.date).toBe(true);
    }
  });

  test("positionInWeeklyRange is clamped to [0,1]", () => {
    const dailies = Array.from({ length: 7 }, (_, i) =>
      dailyCandle(7 - i, { high: 100, low: 90, close: 95 }),
    );
    const above = summarizeHtf(dailies, 200);
    expect(above.positionInWeeklyRange).toBe(1);
    const below = summarizeHtf(dailies, 10);
    expect(below.positionInWeeklyRange).toBe(0);
  });
});
