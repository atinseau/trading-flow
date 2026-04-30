import { describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { rsiPlugin } from "@adapters/indicators/plugins/rsi";

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

  test("resolveActive returns rsi plugin when enabled", () => {
    const reg = new IndicatorRegistry();
    const result = reg.resolveActive({ rsi: { enabled: true } });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("rsi");
  });

  test("byId returns rsiPlugin", () => {
    const reg = new IndicatorRegistry();
    expect(reg.byId("rsi")).toBe(rsiPlugin);
  });

  test("byId returns undefined for unknown id", () => {
    const reg = new IndicatorRegistry([]);
    expect(reg.byId("volume" as Parameters<InstanceType<typeof IndicatorRegistry>["byId"]>[0])).toBeUndefined();
  });

  test("allChartScripts returns rsi chart script", () => {
    const reg = new IndicatorRegistry();
    expect(reg.allChartScripts()).toContain("rsi");
    expect(reg.allChartScripts()).toContain("RSI(14)");
  });

  test("all() returns array containing rsiPlugin", () => {
    const reg = new IndicatorRegistry();
    expect(reg.all().length).toBeGreaterThanOrEqual(1);
    expect(reg.all().some((p) => p.id === "rsi")).toBe(true);
  });
});
