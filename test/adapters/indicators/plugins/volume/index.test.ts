import { describe, expect, test } from "bun:test";
import { volumePlugin } from "@adapters/indicators/plugins/volume";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100,
  high: 101,
  low: 99,
  close: 100 + Math.sin(i / 10),
  volume: 1000 + i * 5,
}));

describe("volumePlugin", () => {
  test("metadata — id, tag, breakdownAxes=['volume'], preFilterCriterion='volume_spike_min'", () => {
    expect(volumePlugin.id).toBe("volume");
    expect(volumePlugin.tag).toBe("volume");
    expect(volumePlugin.chartPane).toBe("secondary");
    expect(volumePlugin.breakdownAxes).toEqual(["volume"]);
    expect(volumePlugin.preFilterCriterion).toBe("volume_spike_min");
  });

  test("computeScalars returns volumeMa20, lastVolume, volumePercentile200", () => {
    const s = volumePlugin.computeScalars(sampleCandles);
    expect(s.volumeMa20).toBeDefined();
    expect(s.lastVolume).toBeDefined();
    expect(s.volumePercentile200).toBeDefined();
    expect(typeof s.volumeMa20).toBe("number");
    expect(typeof s.lastVolume).toBe("number");
    expect(typeof s.volumePercentile200).toBe("number");
    expect(s.volumeMa20 as number).toBeGreaterThanOrEqual(0);
    expect(s.volumePercentile200 as number).toBeGreaterThanOrEqual(0);
    expect(s.volumePercentile200 as number).toBeLessThanOrEqual(100);
  });

  test("computeSeries returns compound (histogram bars + MA20 lines) of length n", () => {
    const series = volumePlugin.computeSeries(sampleCandles);
    if (series.kind !== "compound") throw new Error("expected compound kind");
    const hist = series.parts.find((p) => p.kind === "histogram");
    const lines = series.parts.find((p) => p.kind === "lines");
    if (hist?.kind !== "histogram" || lines?.kind !== "lines") {
      throw new Error("expected histogram + lines parts");
    }
    expect(hist.values.length).toBe(250);
    expect(lines.series.volumeMa20).toBeDefined();
    expect(lines.series.volumeMa20.length).toBe(250);
  });

  test("detectorPromptFragment includes volume labels", () => {
    const s = volumePlugin.computeScalars(sampleCandles);
    const txt = volumePlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("Volume");
    expect(txt).toContain("MA20");
  });

  test("featuredFewShotExample contains volume climax pattern", () => {
    const ex = volumePlugin.featuredFewShotExample?.();
    expect(ex).toBeTruthy();
    expect(ex!).toContain("volume_climax");
    expect(ex!).toContain("percentile");
  });

  describe("computeScalarHistory", () => {
    test("returns raw volume series + volumeMa20 tail", () => {
      const out = volumePlugin.computeScalarHistory?.(sampleCandles, undefined, 10);
      expect(out?.volume.length).toBe(10);
      expect(out?.volumeMa20.length).toBe(10);
      // Volume raw is never null (came from candles directly).
      expect(out?.volume.every((v) => v != null)).toBe(true);
    });

    test("last volume in history matches last candle volume", () => {
      const out = volumePlugin.computeScalarHistory?.(sampleCandles, undefined, 5);
      expect(out?.volume[4]).toBe(sampleCandles[sampleCandles.length - 1]!.volume);
    });

    test("n=0 returns empty arrays", () => {
      const out = volumePlugin.computeScalarHistory?.(sampleCandles, undefined, 0);
      expect(out).toEqual({ volume: [], volumeMa20: [] });
    });
  });
});
