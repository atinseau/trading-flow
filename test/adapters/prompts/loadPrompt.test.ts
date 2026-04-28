import { afterEach, expect, test } from "bun:test";
import { clearPromptCache, loadPrompt } from "@adapters/prompts/loadPrompt";

afterEach(() => {
  clearPromptCache();
});

test("loadPrompt('detector') returns rendered template + version", async () => {
  const result = await loadPrompt("detector");
  expect(result.version).toBe("detector_v1");
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
  expect(text).toContain("aucun setup vivant");
});

test("loadPrompt('reviewer') extracts version", async () => {
  const result = await loadPrompt("reviewer");
  expect(result.version).toBe("reviewer_v1");
});

test("loadPrompt('finalizer') extracts version", async () => {
  const result = await loadPrompt("finalizer");
  expect(result.version).toBe("finalizer_v1");
});

test("loadPrompt is cached (same instance returned)", async () => {
  const a = await loadPrompt("detector");
  const b = await loadPrompt("detector");
  expect(a.render).toBe(b.render); // same compiled template
});
