import { describe, expect, test } from "bun:test";
import { macdPlugin } from "@adapters/indicators/plugins/macd";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 10), volume: 1000,
}));

describe("macdPlugin", () => {
  test("metadata — id, tag, chartPane=secondary", () => {
    expect(macdPlugin.id).toBe("macd");
    expect(macdPlugin.tag).toBe("momentum");
    expect(macdPlugin.chartPane).toBe("secondary");
    expect(macdPlugin.secondaryPaneStretch).toBe(13);
  });

  test("computeScalars returns macd/macdSignal/macdHist", () => {
    const s = macdPlugin.computeScalars(sampleCandles);
    expect(s.macd).toBeDefined();
    expect(s.macdSignal).toBeDefined();
    expect(s.macdHist).toBeDefined();
    expect(typeof s.macd).toBe("number");
    expect(typeof s.macdSignal).toBe("number");
    expect(typeof s.macdHist).toBe("number");
  });

  test("computeSeries returns lines kind with macd/signal/hist", () => {
    const series = macdPlugin.computeSeries(sampleCandles);
    if (series.kind !== "lines") throw new Error("expected lines kind");
    expect(series.series.macd).toBeDefined();
    expect(series.series.signal).toBeDefined();
    expect(series.series.hist).toBeDefined();
    expect(series.series.macd.length).toBe(250);
  });

  test("detectorPromptFragment includes macd/signal/hist labels", () => {
    const s = macdPlugin.computeScalars(sampleCandles);
    const txt = macdPlugin.detectorPromptFragment(s);
    expect(txt).not.toBeNull();
    expect(txt).toContain("MACD");
    expect(txt).toContain("signal");
    expect(txt).toContain("hist");
  });

  test("reviewerPromptFragment is condensed", () => {
    const s = macdPlugin.computeScalars(sampleCandles);
    const txt = macdPlugin.reviewerPromptFragment?.(s);
    expect(txt).toBeTruthy();
    expect(txt!.length).toBeLessThan(60);
  });

  test("chartScript contains registerPlugin macd", () => {
    expect(macdPlugin.chartScript).toContain('__registerPlugin("macd"');
  });

  test("computeScalars uses default params when no params", () => {
    const s = macdPlugin.computeScalars(sampleCandles);
    expect(s.macd).toBeDefined();
    expect(s.macdSignal).toBeDefined();
    expect(s.macdHist).toBeDefined();
  });

  test("computeScalars accepts custom params", () => {
    const sDefault = macdPlugin.computeScalars(sampleCandles);
    const sCustom = macdPlugin.computeScalars(sampleCandles, { fast: 5, slow: 15, signal: 5 });
    expect(typeof sCustom.macd).toBe("number");
    // Different periods should produce different MACD values
    expect(sDefault.macd).not.toBe(sCustom.macd);
  });

  test("paramsSchema validates ranges", () => {
    expect(() => macdPlugin.paramsSchema!.parse({ fast: 1, slow: 26, signal: 9 })).toThrow(); // fast below min
    expect(() => macdPlugin.paramsSchema!.parse({ fast: 12, slow: 51, signal: 9 })).toThrow(); // slow above max
    expect(() => macdPlugin.paramsSchema!.parse({ fast: 26, slow: 12, signal: 9 })).toThrow(); // fast >= slow
    expect(macdPlugin.paramsSchema!.parse({ fast: 12, slow: 26, signal: 9 })).toEqual({ fast: 12, slow: 26, signal: 9 });
  });

  test("defaultParams matches schema", () => {
    expect(macdPlugin.paramsSchema!.parse(macdPlugin.defaultParams!)).toEqual(macdPlugin.defaultParams!);
  });
});

// ─── Ported from PureJsIndicatorCalculator.coverage.test.ts ──────────────────

function fromCloses(closes: number[], stepMs = 900_000, startMs = 0) {
  return closes.map((close, i) => ({
    timestamp: new Date(startMs + i * stepMs),
    open: i === 0 ? close : (closes[i - 1] ?? close),
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 100,
  }));
}

describe("macdPlugin — deeper coverage [ported]", () => {
  test("histogram === macd - signal across many indices", () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.05);
    const candles = fromCloses(closes);
    const raw = macdPlugin.computeSeries(candles);
    if (raw.kind !== "lines") throw new Error("expected lines kind");
    const macdArr = raw.series.macd;
    const signalArr = raw.series.signal;
    const histArr = raw.series.hist;
    let checked = 0;
    for (let i = 0; i < macdArr.length; i++) {
      const m = macdArr[i];
      const s = signalArr[i];
      const h = histArr[i];
      if (m == null || s == null || h == null) continue;
      expect(h).toBeCloseTo(m - s, 8);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("histogram flips negative → positive across a downtrend-to-uptrend pivot", () => {
    const closes: number[] = [];
    for (let i = 0; i < 150; i++) closes.push(200 - i * 0.5);
    for (let i = 0; i < 100; i++) closes.push(125 + i * 0.8);
    const candles = fromCloses(closes);
    const raw = macdPlugin.computeSeries(candles);
    if (raw.kind !== "lines") throw new Error("expected lines kind");
    const histArr = raw.series.hist;
    const downHist = histArr[130];
    expect(downHist).not.toBeNull();
    expect(downHist as number).toBeLessThan(0);
    const lastHist = histArr[histArr.length - 1];
    expect(lastHist).not.toBeNull();
    expect(lastHist as number).toBeGreaterThan(0);
  });

  test("cycling sine series → macd takes both positive and negative values", () => {
    const closes = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 10) * 5);
    const candles = fromCloses(closes);
    const raw = macdPlugin.computeSeries(candles);
    if (raw.kind !== "lines") throw new Error("expected lines kind");
    const macdArr = raw.series.macd;
    let posCount = 0;
    let negCount = 0;
    for (const v of macdArr) {
      if (v == null) continue;
      if (v > 0.01) posCount++;
      else if (v < -0.01) negCount++;
    }
    expect(posCount).toBeGreaterThan(20);
    expect(negCount).toBeGreaterThan(20);
  });
});
