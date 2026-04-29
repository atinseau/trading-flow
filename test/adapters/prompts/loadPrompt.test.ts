import { afterEach, expect, test } from "bun:test";
import { clearPromptCache, loadPrompt } from "@adapters/prompts/loadPrompt";

afterEach(() => {
  clearPromptCache();
});

test("loadPrompt('detector') returns rendered template + version", async () => {
  const result = await loadPrompt("detector");
  expect(result.version).toBe("detector_v4");
  expect(typeof result.render).toBe("function");

  // Render with sample context
  const text = result.render({
    asset: "BTCUSDT",
    timeframe: "1h",
    tickAt: "2026-04-28T14:00:00Z",
    indicators: { rsi: 50, ema20: 100 },
    aliveSetups: [],
  });
  expect(text).toContain("BTCUSDT");
  expect(text).toContain("1h");
  expect(text).toContain("no alive setups");
});

test("loadPrompt('reviewer') extracts version", async () => {
  const result = await loadPrompt("reviewer");
  expect(result.version).toBe("reviewer_v4");
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

  // Detector — non-empty: block renders
  const detectorWith = detector.render({
    asset: "BTCUSDT",
    timeframe: "1h",
    tickAt: "2026-04-28T14:00:00Z",
    indicators: { rsi: 50 },
    aliveSetups: [],
    activeLessons: lessons,
  });
  expect(detectorWith).toContain("Active guidelines (learned from previous trades)");
  expect(detectorWith).toContain("Avoid breakouts on thin volume");

  // Detector — empty/omitted: block disappears (no leaked placeholder)
  const detectorWithout = detector.render({
    asset: "BTCUSDT",
    timeframe: "1h",
    tickAt: "2026-04-28T14:00:00Z",
    indicators: { rsi: 50 },
    aliveSetups: [],
    activeLessons: [],
  });
  expect(detectorWithout).not.toContain("Active guidelines");

  // Reviewer — non-empty + empty
  const reviewerWith = reviewer.render({
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
    fresh: { lastClose: 101, indicators: { rsi: 40, atr: 1 } },
    activeLessons: lessons,
  });
  expect(reviewerWith).toContain("Active guidelines (learned from previous trades)");

  const reviewerWithout = reviewer.render({
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
    fresh: { lastClose: 101, indicators: { rsi: 40, atr: 1 } },
    activeLessons: [],
  });
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
