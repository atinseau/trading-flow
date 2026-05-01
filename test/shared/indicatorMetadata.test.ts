import { describe, expect, test } from "bun:test";
import { INDICATOR_METADATA } from "@shared/indicatorMetadata";

describe("INDICATOR_METADATA", () => {
  test("rsi metadata exposes defaultParams + paramsDescriptor", () => {
    const rsi = INDICATOR_METADATA.find((m) => m.id === "rsi")!;
    expect(rsi.defaultParams).toEqual({ period: 14 });
    expect(rsi.paramsDescriptor).toBeTruthy();
    expect(rsi.paramsDescriptor![0]!.key).toBe("period");
  });

  test("liquidity_pools has no params (no descriptor)", () => {
    const lp = INDICATOR_METADATA.find((m) => m.id === "liquidity_pools")!;
    expect(lp.paramsDescriptor).toBeUndefined();
  });

  test("each parameterized plugin has matching defaultParams + paramsDescriptor keys", () => {
    for (const m of INDICATOR_METADATA) {
      if (!m.paramsDescriptor) continue;
      const descKeys = new Set(m.paramsDescriptor.map((d) => d.key));
      const defaultKeys = new Set(Object.keys(m.defaultParams ?? {}));
      expect(descKeys).toEqual(defaultKeys);
    }
  });

  test("all 10 indicators are present", () => {
    const ids = INDICATOR_METADATA.map((m) => m.id);
    expect(ids).toContain("rsi");
    expect(ids).toContain("ema_stack");
    expect(ids).toContain("bollinger");
    expect(ids).toContain("atr");
    expect(ids).toContain("macd");
    expect(ids).toContain("swings_bos");
    expect(ids).toContain("structure_levels");
    expect(ids).toContain("volume");
    expect(ids).toContain("vwap");
    expect(ids).toContain("liquidity_pools");
  });

  test("parameterized plugins have correct defaultParam values", () => {
    const byId = Object.fromEntries(INDICATOR_METADATA.map((m) => [m.id, m]));
    expect(byId.rsi!.defaultParams).toEqual({ period: 14 });
    expect(byId.atr!.defaultParams).toEqual({ period: 14 });
    expect(byId.bollinger!.defaultParams).toEqual({ period: 20, std_mul: 2 });
    expect(byId.macd!.defaultParams).toEqual({ fast: 12, slow: 26, signal: 9 });
    expect(byId.swings_bos!.defaultParams).toEqual({ lookback: 3 });
    expect(byId.structure_levels!.defaultParams).toEqual({ window: 50, poc_buckets: 30 });
    expect(byId.ema_stack!.defaultParams).toEqual({
      period_short: 20,
      period_mid: 50,
      period_long: 200,
    });
  });
});
