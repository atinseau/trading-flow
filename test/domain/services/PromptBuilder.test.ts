// test/domain/services/PromptBuilder.test.ts
import { beforeAll, describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { FewShotEngine } from "@domain/services/FewShotEngine";
import { PromptBuilder } from "@domain/services/PromptBuilder";

const baseArgs = {
  asset: "BTCUSDT",
  timeframe: "1h",
  tickAt: new Date("2026-04-30T10:00:00Z"),
  scalars: {},
  activeLessons: [],
  aliveSetups: [],
  htf: undefined,
  candles: [
    {
      timestamp: new Date("2026-04-30T09:00:00Z"),
      open: 76000,
      high: 76200,
      low: 75950,
      close: 76150,
      volume: 120,
    },
    {
      timestamp: new Date("2026-04-30T10:00:00Z"),
      open: 76150,
      high: 76300,
      low: 76050,
      close: 76250,
      volume: 145,
    },
  ],
  promptData: {
    recent_ohlcv_count: 0, // disabled by default in tests to keep assertions simple
    indicator_history_count: 0,
    include_recent_in_finalizer: true,
    decimals: null,
    timestamp_format: "time" as const,
    include_volume: true,
  },
};

describe("PromptBuilder.buildDetectorPrompt", () => {
  let builder: PromptBuilder;
  beforeAll(async () => {
    builder = new PromptBuilder(new IndicatorRegistry(), new FewShotEngine());
    await builder.warmUp();
  });

  test("naked: contains 'Naked-mode' and no Indicators block", async () => {
    const out = await builder.buildDetectorPrompt({
      ...baseArgs,
      indicatorsMatrix: {},
    });
    expect(out).toContain("Naked-mode analysis");
    expect(out).not.toContain("## Indicators (fresh data");
    expect(out).toContain('"clarity"');
    expect(out).not.toContain("## Volume rules");
  });

  test("rsi only: contains Indicators block + RSI fragment", async () => {
    const out = await builder.buildDetectorPrompt({
      ...baseArgs,
      scalars: { rsi: 50 },
      indicatorsMatrix: { rsi: { enabled: true } },
    });
    expect(out).toContain("## Indicators (fresh data");
    expect(out).toContain("**RSI (14)**");
    expect(out).not.toContain("## Volume rules");
    expect(out).toContain("trigger");
  });

  test("volume active: includes Volume rules block + volume axis", async () => {
    const out = await builder.buildDetectorPrompt({
      ...baseArgs,
      scalars: { volumeMa20: 100, lastVolume: 200, volumePercentile200: 80 },
      indicatorsMatrix: { volume: { enabled: true } },
    });
    expect(out).toContain("## Volume rules");
    expect(out).toContain('"volume"');
  });

  test("prompt_data.recent_ohlcv_count > 0 injects the OHLCV table", async () => {
    const out = await builder.buildDetectorPrompt({
      ...baseArgs,
      indicatorsMatrix: {},
      promptData: { ...baseArgs.promptData, recent_ohlcv_count: 2 },
    });
    expect(out).toContain("## Recent OHLCV (last 2 candles");
    expect(out).toContain("| # | time | O | H | L | C | V |");
    expect(out).toContain("76250"); // last close
  });

  test("prompt_data.recent_ohlcv_count = 0 omits the section entirely", async () => {
    const out = await builder.buildDetectorPrompt({
      ...baseArgs,
      indicatorsMatrix: {},
    });
    expect(out).not.toContain("## Recent OHLCV");
  });

  test("indicator_history_count > 0 + active RSI → 'Last values' line appears", async () => {
    // Build a candle window long enough to compute RSI(14) tail.
    const candles = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(2026, 3, 30, 10, i),
      open: 100 + i,
      high: 100 + i + 1,
      low: 100 + i - 1,
      close: 100 + i,
      volume: 50 + i,
    }));
    const out = await builder.buildDetectorPrompt({
      ...baseArgs,
      candles,
      scalars: { rsi: 50 },
      indicatorsMatrix: { rsi: { enabled: true } },
      promptData: { ...baseArgs.promptData, indicator_history_count: 5 },
    });
    expect(out).toContain("**RSI (14)**");
    expect(out).toContain("Last values:");
    // RSI on a monotonic ramp should drift toward extremes — exact value
    // doesn't matter for this assertion, just that the line was injected.
    expect(out).toMatch(/Last values: [\d.]+ → [\d.]+ → [\d.]+ → [\d.]+ → [\d.]+/);
  });

  test("indicator_history_count = 0 → fragment falls back to spot value only", async () => {
    const candles = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(2026, 3, 30, 10, i),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 100,
    }));
    const out = await builder.buildDetectorPrompt({
      ...baseArgs,
      candles,
      scalars: { rsi: 50 },
      indicatorsMatrix: { rsi: { enabled: true } },
      // explicit override : keep history disabled
      promptData: { ...baseArgs.promptData, indicator_history_count: 0 },
    });
    expect(out).toContain("**RSI (14)**");
    expect(out).not.toContain("Last values:");
  });
});
