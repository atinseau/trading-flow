import { describe, expect, test } from "bun:test";
import { computeTradeMetrics } from "@domain/services/computeTradeMetrics";

describe("computeTradeMetrics", () => {
  test("LONG win at 1R = +1.0 R-multiple", () => {
    const m = computeTradeMetrics({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 90,
      exitPrice: 110,
    });
    expect(m.rMultiple).toBeCloseTo(1.0, 5);
    expect(m.pnlPct).toBeCloseTo(10, 5);
  });

  test("LONG loss at SL = -1.0 R-multiple", () => {
    const m = computeTradeMetrics({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 90,
      exitPrice: 90,
    });
    expect(m.rMultiple).toBeCloseTo(-1.0, 5);
    expect(m.pnlPct).toBeCloseTo(-10, 5);
  });

  test("SHORT win = positive R-multiple (price moved down)", () => {
    const m = computeTradeMetrics({
      direction: "SHORT",
      entryPrice: 100,
      stopLoss: 110,
      exitPrice: 80,
    });
    expect(m.rMultiple).toBeCloseTo(2.0, 5);
    expect(m.pnlPct).toBeCloseTo(20, 5);
  });

  test("SHORT loss at SL = -1.0 R-multiple", () => {
    const m = computeTradeMetrics({
      direction: "SHORT",
      entryPrice: 100,
      stopLoss: 110,
      exitPrice: 110,
    });
    expect(m.rMultiple).toBeCloseTo(-1.0, 5);
    expect(m.pnlPct).toBeCloseTo(-10, 5);
  });

  test("partial win at +0.5R", () => {
    const m = computeTradeMetrics({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 90,
      exitPrice: 105,
    });
    expect(m.rMultiple).toBeCloseTo(0.5, 5);
    expect(m.pnlPct).toBeCloseTo(5, 5);
  });

  test("breakeven exit (after trailing) = 0R", () => {
    const m = computeTradeMetrics({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 90,
      exitPrice: 100,
    });
    expect(m.rMultiple).toBeCloseTo(0, 5);
    expect(m.pnlPct).toBeCloseTo(0, 5);
  });

  test("3R win on tight stop", () => {
    const m = computeTradeMetrics({
      direction: "LONG",
      entryPrice: 1000,
      stopLoss: 990,
      exitPrice: 1030,
    });
    expect(m.rMultiple).toBeCloseTo(3.0, 5);
    expect(m.pnlPct).toBeCloseTo(3, 5);
  });

  test("degenerate stopLoss == entry → rMultiple = 0 (no division by zero)", () => {
    const m = computeTradeMetrics({
      direction: "LONG",
      entryPrice: 100,
      stopLoss: 100,
      exitPrice: 110,
    });
    expect(m.rMultiple).toBe(0);
    expect(m.pnlPct).toBeCloseTo(10, 5);
  });

  test("entryPrice = 0 (degenerate) → pnlPct = 0", () => {
    const m = computeTradeMetrics({
      direction: "LONG",
      entryPrice: 0,
      stopLoss: -10,
      exitPrice: 10,
    });
    expect(m.pnlPct).toBe(0);
  });
});
