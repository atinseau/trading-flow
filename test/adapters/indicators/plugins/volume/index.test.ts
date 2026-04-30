import { describe, expect, test } from "bun:test";
import { volumePlugin } from "@adapters/indicators/plugins/volume";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 10), volume: 1000 + i * 5,
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

  test("computeSeries returns volumeMa20 lines of length n", () => {
    const series = volumePlugin.computeSeries(sampleCandles);
    if (series.kind !== "lines") throw new Error("expected lines kind");
    expect(series.series.volumeMa20).toBeDefined();
    expect(series.series.volumeMa20.length).toBe(250);
  });

  test("detectorPromptFragment includes volume labels", () => {
    const s = volumePlugin.computeScalars(sampleCandles);
    const txt = volumePlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("Volume");
    expect(txt).toContain("MA20");
  });

  test("chartScript contains registerPlugin volume", () => {
    expect(volumePlugin.chartScript).toContain('__registerPlugin("volume"');
  });
});
