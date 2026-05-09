import { describe, expect, test } from "bun:test";
import {
  bucketRMultiples,
  buildEquityCurve,
  type ClosedTrade,
  summarizeTrades,
} from "@domain/services/aggregateTradeStats";

const t = (rMultiple: number, closedAt?: string): ClosedTrade => ({
  rMultiple,
  closedAt: closedAt ?? null,
});

describe("buildEquityCurve", () => {
  test("empty array → empty curve, zero metrics", () => {
    const out = buildEquityCurve([]);
    expect(out.equityCurve).toEqual([]);
    expect(out.totalR).toBe(0);
    expect(out.maxDrawdownR).toBe(0);
  });

  test("single +1R trade → curve [1], total +1, dd 0", () => {
    const out = buildEquityCurve([t(1)]);
    expect(out.equityCurve).toEqual([{ closedAt: null, cumulativeR: 1 }]);
    expect(out.totalR).toBe(1);
    expect(out.maxDrawdownR).toBe(0);
  });

  test("monotonic up: +1, +1, +1 → no drawdown", () => {
    const out = buildEquityCurve([t(1), t(1), t(1)]);
    expect(out.equityCurve.map((p) => p.cumulativeR)).toEqual([1, 2, 3]);
    expect(out.maxDrawdownR).toBe(0);
  });

  test("max drawdown peak-to-trough", () => {
    // cumulative: 1, 3, 2, 0, 2 → peaks 1, 3, 3, 3, 3 → DDs 0, 0, 1, 3, 1 → max 3
    const out = buildEquityCurve([t(1), t(2), t(-1), t(-2), t(2)]);
    expect(out.equityCurve.map((p) => p.cumulativeR)).toEqual([1, 3, 2, 0, 2]);
    expect(out.maxDrawdownR).toBe(3);
    expect(out.totalR).toBe(2);
  });

  test("losing strategy: pure descending → DD = sum of losses", () => {
    const out = buildEquityCurve([t(-1), t(-1), t(-1)]);
    expect(out.totalR).toBe(-3);
    // Peak stays at 0; trough is -3 → DD = 3.
    expect(out.maxDrawdownR).toBe(3);
  });

  test("preserves closedAt strings", () => {
    const iso = "2025-01-15T12:00:00.000Z";
    const out = buildEquityCurve([t(1, iso)]);
    expect(out.equityCurve[0]?.closedAt).toBe(iso);
  });

  test("handles Date objects in closedAt", () => {
    const d = new Date("2025-03-01T00:00:00.000Z");
    const out = buildEquityCurve([{ rMultiple: 1, closedAt: d }]);
    expect(out.equityCurve[0]?.closedAt).toBe(d.toISOString());
  });
});

describe("bucketRMultiples", () => {
  test("empty → empty buckets", () => {
    expect(bucketRMultiples([])).toEqual([]);
  });

  test("0.5R bucketing", () => {
    const trades = [t(0.1), t(0.6), t(1.2), t(1.4), t(-0.3), t(-1.0)];
    // -0.3 → -0.5 bucket; -1.0 → -1.0; 0.1 → 0; 0.6 → 0.5; 1.2,1.4 → 1.0
    const out = bucketRMultiples(trades, 0.5);
    expect(out).toEqual([
      { bucket: -1.0, count: 1 },
      { bucket: -0.5, count: 1 },
      { bucket: 0, count: 1 },
      { bucket: 0.5, count: 1 },
      { bucket: 1.0, count: 2 },
    ]);
  });

  test("buckets are sorted ascending", () => {
    const trades = [t(2), t(-2), t(0), t(1)];
    const out = bucketRMultiples(trades);
    const buckets = out.map((b) => b.bucket);
    expect([...buckets].sort((a, b) => a - b)).toEqual(buckets);
  });

  test("custom bucket size", () => {
    const trades = [t(0.1), t(0.4), t(0.9)];
    const out = bucketRMultiples(trades, 1);
    expect(out).toEqual([{ bucket: 0, count: 3 }]);
  });
});

describe("summarizeTrades", () => {
  test("empty → null winRate, all zeros", () => {
    const s = summarizeTrades([]);
    expect(s.tradeCount).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.expectancy).toBeNull();
  });

  test("100% win rate, profit factor null (no losses)", () => {
    const s = summarizeTrades([t(1), t(2)]);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(0);
    expect(s.winRate).toBe(1);
    expect(s.profitFactor).toBeNull();
  });

  test("typical: 3W +1R + 1W +2R + 2L -1R = profit factor 5/2 = 2.5", () => {
    const s = summarizeTrades([t(1), t(1), t(1), t(2), t(-1), t(-1)]);
    expect(s.wins).toBe(4);
    expect(s.losses).toBe(2);
    expect(s.winRate).toBeCloseTo(4 / 6, 4);
    expect(s.totalR).toBe(3);
    expect(s.profitFactor).toBeCloseTo(2.5, 4);
    expect(s.expectancy).toBeCloseTo(0.5, 4);
    expect(s.avgWin).toBeCloseTo(1.25, 4);
    expect(s.avgLoss).toBeCloseTo(-1, 4);
  });

  test("breakeven trades counted separately", () => {
    const s = summarizeTrades([t(1), t(0), t(0), t(-1)]);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.breakeven).toBe(2);
    // winRate uses only wins+losses (excludes BE)
    expect(s.winRate).toBeCloseTo(0.5, 4);
  });

  test("losing strategy: profit factor < 1", () => {
    const s = summarizeTrades([t(1), t(-2), t(-2)]);
    expect(s.profitFactor).toBeCloseTo(1 / 4, 4);
    expect(s.expectancy).toBeCloseTo(-1, 4);
  });
});
