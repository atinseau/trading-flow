import { describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { KNOWN_INDICATOR_IDS } from "@domain/schemas/WatchesConfig";

describe("IndicatorRegistry full", () => {
  test("registers all 12 KNOWN_INDICATOR_IDS", () => {
    const reg = new IndicatorRegistry();
    const registered = reg.all().map((p) => p.id).sort();
    const known = [...KNOWN_INDICATOR_IDS].sort();
    expect(registered).toEqual(known);
  });

  test("resolveActive honours the matrix", () => {
    const reg = new IndicatorRegistry();
    const active = reg.resolveActive({
      rsi: { enabled: true }, volume: { enabled: true }, ema_stack: { enabled: false },
    });
    expect(active.map((p) => p.id).sort()).toEqual(["rsi", "volume"]);
  });

  test("allChartScripts concatenates non-empty strings", () => {
    const reg = new IndicatorRegistry();
    const all = reg.allChartScripts();
    expect(all.length).toBeGreaterThan(0);
    expect(all).toContain('__registerPlugin("rsi"');
    expect(all).toContain('__registerPlugin("volume"');
  });
});
