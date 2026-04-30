import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { rsiPlugin } from "@adapters/indicators/plugins/rsi";

const candles = (count: number, baseClose = 100) =>
  Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1, i)),
    open: baseClose, high: baseClose + 1, low: baseClose - 1,
    close: baseClose + (i % 3 - 1), volume: 1000,
  }));

describe("rsiPlugin", () => {
  test("metadata is correct", () => {
    expect(rsiPlugin.id).toBe("rsi");
    expect(rsiPlugin.tag).toBe("momentum");
    expect(rsiPlugin.preFilterCriterion).toBe("rsi_extreme_distance");
  });

  test("computeScalars returns rsi in 0..100", () => {
    const s = rsiPlugin.computeScalars(candles(50));
    expect(s.rsi).toBeDefined();
    expect(typeof s.rsi).toBe("number");
    expect(s.rsi as number).toBeGreaterThanOrEqual(0);
    expect(s.rsi as number).toBeLessThanOrEqual(100);
  });

  test("computeSeries returns aligned line series of length n", () => {
    const c = candles(50);
    const series = rsiPlugin.computeSeries(c);
    expect(series.kind).toBe("lines");
    if (series.kind !== "lines") throw new Error();
    expect(series.series.rsi.length).toBe(50);
  });

  test("scalarSchemaFragment validates rsi number", () => {
    const fragment = rsiPlugin.scalarSchemaFragment();
    expect(fragment.rsi).toBeDefined();
    expect(z.parse(fragment.rsi, 45)).toBe(45);
    expect(() => z.parse(fragment.rsi, 150)).toThrow();
  });

  test("detectorPromptFragment includes RSI label and value", () => {
    const txt = rsiPlugin.detectorPromptFragment({ rsi: 67.5 });
    expect(txt).toContain("RSI");
    expect(txt).toContain("67.50");
  });

  test("reviewerPromptFragment is condensed", () => {
    const txt = rsiPlugin.reviewerPromptFragment?.({ rsi: 67.5 });
    expect(txt).toBeTruthy();
    expect(txt!.length).toBeLessThan(60);
  });
});
