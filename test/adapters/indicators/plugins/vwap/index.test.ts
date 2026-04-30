import { describe, expect, test } from "bun:test";
import { vwapPlugin } from "@adapters/indicators/plugins/vwap";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 10), volume: 1000,
}));

describe("vwapPlugin", () => {
  test("metadata", () => {
    expect(vwapPlugin.id).toBe("vwap");
    expect(vwapPlugin.tag).toBe("trend");
    expect(vwapPlugin.chartPane).toBe("price_overlay");
  });

  test("computeScalars includes vwapSession + priceVsVwapPct", () => {
    const s = vwapPlugin.computeScalars(sampleCandles);
    expect(s.vwapSession).toBeDefined();
    expect(s.priceVsVwapPct).toBeDefined();
    expect(typeof s.vwapSession).toBe("number");
    expect(typeof s.priceVsVwapPct).toBe("number");
  });

  test("computeSeries returns vwap line series", () => {
    const series = vwapPlugin.computeSeries(sampleCandles);
    if (series.kind !== "lines") throw new Error("expected lines kind");
    expect(series.series.vwap).toBeDefined();
    expect(series.series.vwap.length).toBe(250);
  });

  test("detectorPromptFragment includes VWAP label and pct", () => {
    const s = vwapPlugin.computeScalars(sampleCandles);
    const txt = vwapPlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("VWAP session");
    expect(txt).toContain("price vs VWAP");
  });

  test("chartScript contains registerPlugin vwap", () => {
    expect(vwapPlugin.chartScript).toContain('__registerPlugin("vwap"');
  });
});
