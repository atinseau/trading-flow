import { describe, expect, test } from "bun:test";
import {
  ema, emaSeriesAligned, atrSeries, rsi, rsiSeriesAligned,
  bollingerLast, bollingerSeriesAligned, macdSeriesAligned,
  rollingMaAligned, percentileOf, zScoreOfLast, movingAverage,
} from "@adapters/indicators/plugins/base/math";

describe("base/math", () => {
  test("ema converges on constant input", () => {
    const e = ema([10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 5);
    expect(e).toBeCloseTo(10, 6);
  });

  test("rsi on strictly increasing closes is 100", () => {
    expect(rsi([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], 14)).toBe(100);
  });

  test("percentileOf returns 50 on empty sample", () => {
    expect(percentileOf(5, [])).toBe(50);
  });

  test("zScoreOfLast returns 0 on flat series", () => {
    expect(zScoreOfLast([1,1,1,1,1,1], 6)).toBe(0);
  });

  test("emaSeriesAligned has length n with leading nulls before warm-up", () => {
    const closes = Array.from({ length: 50 }, (_, i) => i + 1);
    const series = emaSeriesAligned(closes, 20, 50);
    expect(series.length).toBe(50);
    expect(series[18]).toBeNull();
    expect(series[19]).not.toBeNull();
  });

  test("atrSeries returns non-empty for sufficient input", () => {
    const highs = Array.from({ length: 20 }, (_, i) => 100 + i);
    const lows = Array.from({ length: 20 }, (_, i) => 99 + i);
    const closes = Array.from({ length: 20 }, (_, i) => 99.5 + i);
    const series = atrSeries(highs, lows, closes, 14);
    expect(series.length).toBeGreaterThan(0);
  });

  test("rsiSeriesAligned has correct length", () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1);
    const series = rsiSeriesAligned(closes, 14, 20);
    expect(series.length).toBe(20);
  });

  test("bollingerLast returns equal bands on insufficient data", () => {
    const result = bollingerLast([10], 20, 2);
    expect(result.upper).toBe(result.lower);
  });

  test("bollingerSeriesAligned returns correct shape", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const result = bollingerSeriesAligned(closes, 20, 2);
    expect(result.upper.length).toBe(30);
    expect(result.middle.length).toBe(30);
    expect(result.lower.length).toBe(30);
  });

  test("macdSeriesAligned returns correct shape", () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
    const result = macdSeriesAligned(closes, 12, 26, 9);
    expect(result.macd.length).toBe(50);
    expect(result.signal.length).toBe(50);
    expect(result.hist.length).toBe(50);
  });

  test("rollingMaAligned returns null for leading positions", () => {
    const values: (number | null)[] = [1, 2, 3, 4, 5];
    const result = rollingMaAligned(values, 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).not.toBeNull();
  });

  test("movingAverage returns correct average", () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toBeCloseTo(4, 6);
  });
});
