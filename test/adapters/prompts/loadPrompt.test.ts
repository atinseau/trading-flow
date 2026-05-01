import { afterEach, expect, test } from "bun:test";
import { clearPromptCache, loadPrompt } from "@adapters/prompts/loadPrompt";

afterEach(() => {
  clearPromptCache();
});

test("loadPrompt('detector') returns rendered template + version", async () => {
  const result = await loadPrompt("detector");
  expect(result.version).toBe("detector_v5");
  expect(typeof result.render).toBe("function");

  // Render with sample context — uses new template variables from PromptBuilder
  const text = result.render({
    asset: "BTCUSDT",
    timeframe: "1h",
    tickAt: "2026-04-28T14:00:00Z",
    hasIndicators: false,
    isVolumeActive: false,
    indicatorFragments: "",
    classificationBlock: "",
    fewShotExamples: "",
    outputFormatTable: "",
    aliveSetups: [],
  });
  expect(text).toContain("BTCUSDT");
  expect(text).toContain("1h");
  expect(text).toContain("no alive setups");
});

test("loadPrompt('reviewer') extracts version", async () => {
  const result = await loadPrompt("reviewer");
  expect(result.version).toBe("reviewer_v5");
});

test("loadPrompt('finalizer') extracts version", async () => {
  const result = await loadPrompt("finalizer");
  expect(result.version).toBe("finalizer_v4");
});

test("activeLessons block renders when non-empty and disappears when empty", async () => {
  const detector = await loadPrompt("detector");
  const reviewer = await loadPrompt("reviewer");
  const finalizer = await loadPrompt("finalizer");

  const lessons = [
    {
      title: "Avoid breakouts on thin volume",
      body: "When the breakout candle volume is below the 20-period MA, treat the level as untested.",
    },
  ];

  const detectorBase = {
    asset: "BTCUSDT",
    timeframe: "1h",
    tickAt: "2026-04-28T14:00:00Z",
    hasIndicators: false,
    isVolumeActive: false,
    indicatorFragments: "",
    classificationBlock: "",
    fewShotExamples: "",
    outputFormatTable: "",
    aliveSetups: [],
  };

  // Detector — non-empty: block renders
  const detectorWith = detector.render({ ...detectorBase, activeLessons: lessons });
  expect(detectorWith).toContain("Active guidelines (learned from previous trades)");
  expect(detectorWith).toContain("Avoid breakouts on thin volume");

  // Detector — empty/omitted: block disappears (no leaked placeholder)
  const detectorWithout = detector.render({ ...detectorBase, activeLessons: [] });
  expect(detectorWithout).not.toContain("Active guidelines");

  const reviewerBase = {
    setup: {
      id: "abc",
      patternHint: "double_bottom",
      direction: "LONG",
      currentScore: 50,
      invalidationLevel: 100,
      ageInCandles: 4,
    },
    history: [],
    tick: { tickAt: "2026-04-28T14:00:00Z" },
    fresh: { lastClose: 101 },
    hasIndicators: false,
    reviewerIndicatorFragments: "",
  };

  // Reviewer — non-empty + empty
  const reviewerWith = reviewer.render({ ...reviewerBase, activeLessons: lessons });
  expect(reviewerWith).toContain("Active guidelines (learned from previous trades)");

  const reviewerWithout = reviewer.render({ ...reviewerBase, activeLessons: [] });
  expect(reviewerWithout).not.toContain("Active guidelines");

  // Finalizer — non-empty + empty
  const finalizerWith = finalizer.render({
    setup: {
      id: "abc",
      asset: "BTCUSDT",
      timeframe: "1h",
      patternHint: "double_bottom",
      direction: "LONG",
      currentScore: 85,
      invalidationLevel: 100,
    },
    historyCount: 0,
    history: [],
    activeLessons: lessons,
  });
  expect(finalizerWith).toContain("Active guidelines (learned from previous trades)");

  const finalizerWithout = finalizer.render({
    setup: {
      id: "abc",
      asset: "BTCUSDT",
      timeframe: "1h",
      patternHint: "double_bottom",
      direction: "LONG",
      currentScore: 85,
      invalidationLevel: 100,
    },
    historyCount: 0,
    history: [],
    activeLessons: [],
  });
  expect(finalizerWithout).not.toContain("Active guidelines");
});

test("activeLessons title/body are NOT HTML-escaped (triple-stache)", async () => {
  const detector = await loadPrompt("detector");
  const reviewer = await loadPrompt("reviewer");
  const finalizer = await loadPrompt("finalizer");

  const lessons = [
    {
      title: "RSI < 30 & EMA200 > price",
      body: "When RSI < 30 & EMA200 > price, don't fade",
    },
  ];

  const detectorOut = detector.render({
    asset: "BTCUSDT",
    timeframe: "1h",
    tickAt: "2026-04-28T14:00:00Z",
    hasIndicators: false,
    isVolumeActive: false,
    indicatorFragments: "",
    classificationBlock: "",
    fewShotExamples: "",
    outputFormatTable: "",
    aliveSetups: [],
    activeLessons: lessons,
  });
  expect(detectorOut).toContain("When RSI < 30 & EMA200 > price, don't fade");
  expect(detectorOut).toContain("RSI < 30 & EMA200 > price");
  expect(detectorOut).not.toContain("&lt;");
  expect(detectorOut).not.toContain("&gt;");
  expect(detectorOut).not.toContain("&amp;");
  expect(detectorOut).not.toContain("&#x27;");

  const reviewerOut = reviewer.render({
    setup: {
      id: "abc",
      patternHint: "double_bottom",
      direction: "LONG",
      currentScore: 50,
      invalidationLevel: 100,
      ageInCandles: 4,
    },
    history: [],
    tick: { tickAt: "2026-04-28T14:00:00Z" },
    fresh: { lastClose: 101 },
    hasIndicators: false,
    reviewerIndicatorFragments: "",
    activeLessons: lessons,
  });
  expect(reviewerOut).toContain("When RSI < 30 & EMA200 > price, don't fade");
  expect(reviewerOut).not.toContain("&lt;");
  expect(reviewerOut).not.toContain("&amp;");
  expect(reviewerOut).not.toContain("&#x27;");

  const finalizerOut = finalizer.render({
    setup: {
      id: "abc",
      asset: "BTCUSDT",
      timeframe: "1h",
      patternHint: "double_bottom",
      direction: "LONG",
      currentScore: 85,
      invalidationLevel: 100,
    },
    historyCount: 0,
    history: [],
    activeLessons: lessons,
  });
  expect(finalizerOut).toContain("When RSI < 30 & EMA200 > price, don't fade");
  expect(finalizerOut).not.toContain("&lt;");
  expect(finalizerOut).not.toContain("&amp;");
  expect(finalizerOut).not.toContain("&#x27;");
});

test("loadPrompt is cached (same instance returned)", async () => {
  const a = await loadPrompt("detector");
  const b = await loadPrompt("detector");
  expect(a.render).toBe(b.render); // same compiled template
});

test("loadPrompt returns systemPrompt as well", async () => {
  const result = await loadPrompt("detector");
  expect(result.systemPrompt).toBeDefined();
  expect(result.systemPrompt.length).toBeGreaterThan(20);
  expect(typeof result.render).toBe("function");
});

test("each role has a distinct system prompt", async () => {
  const detector = await loadPrompt("detector");
  const reviewer = await loadPrompt("reviewer");
  const finalizer = await loadPrompt("finalizer");
  expect(detector.systemPrompt).not.toBe(reviewer.systemPrompt);
  expect(reviewer.systemPrompt).not.toBe(finalizer.systemPrompt);
});
