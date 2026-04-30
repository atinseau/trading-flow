import { describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";

describe("IndicatorRegistry (foundation)", () => {
  test("resolveActive returns empty array on empty matrix", () => {
    const reg = new IndicatorRegistry();
    expect(reg.resolveActive({})).toEqual([]);
  });

  test("resolveActive ignores plugins flagged disabled", () => {
    const reg = new IndicatorRegistry();
    const result = reg.resolveActive({
      rsi: { enabled: false },
      volume: { enabled: false },
    });
    expect(result).toEqual([]);
  });

  test("byId returns undefined when registry is empty", () => {
    const reg = new IndicatorRegistry();
    expect(reg.byId("rsi")).toBeUndefined();
  });

  test("allChartScripts returns empty string", () => {
    const reg = new IndicatorRegistry();
    expect(reg.allChartScripts()).toBe("");
  });
});
