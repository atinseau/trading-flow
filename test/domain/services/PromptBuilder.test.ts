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

describe("PromptBuilder.buildReviewerPrompt", () => {
  let builder: PromptBuilder;
  beforeAll(async () => {
    builder = new PromptBuilder(new IndicatorRegistry(), new FewShotEngine());
    await builder.warmUp();
  });

  const reviewerBase = {
    setup: {
      id: "abc",
      patternHint: "double_bottom",
      direction: "LONG",
      currentScore: 50,
      invalidationLevel: 76000,
      ageInCandles: 4,
    },
    history: [],
    fresh: {
      lastClose: 76450,
      tickAt: new Date("2026-05-19T15:30:00Z"),
      scalars: {},
    },
    activeLessons: [],
    htf: undefined,
    funding: undefined,
    candles: Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(2026, 4, 19, 10, i),
      open: 76400,
      high: 76500,
      low: 76300,
      close: 76450,
      volume: 120 + i,
    })),
    promptData: {
      recent_ohlcv_count: 0,
      indicator_history_count: 0,
      include_recent_in_finalizer: true,
      decimals: null,
      timestamp_format: "time" as const,
      include_volume: true,
    },
  };

  // The plugins that lacked a reviewerPromptFragment before v8.
  // Each test ensures the active plugin's fragment is rendered in the
  // Fresh data block — closes the silent skip bug.
  test("ema_stack active → reviewer prompt mentions EMA stack", async () => {
    const out = await builder.buildReviewerPrompt({
      ...reviewerBase,
      fresh: {
        ...reviewerBase.fresh,
        scalars: { emaShort: 76450, emaMid: 76600, emaLong: 76900 },
      },
      indicatorsMatrix: { ema_stack: { enabled: true } },
    });
    expect(out).toContain("EMA stack");
    expect(out).toContain("76450");
    expect(out).toContain("bearish stack"); // short < mid < long
  });

  test("volume active → reviewer prompt mentions Volume ratio", async () => {
    const out = await builder.buildReviewerPrompt({
      ...reviewerBase,
      fresh: {
        ...reviewerBase.fresh,
        scalars: { lastVolume: 120, volumeMa20: 200, volumePercentile200: 35 },
      },
      indicatorsMatrix: { volume: { enabled: true } },
    });
    expect(out).toContain("Volume:");
    expect(out).toContain("ratio=`0.60`"); // 120/200
  });

  test("fibonacci active (scalars present) → reviewer prompt mentions Fib", async () => {
    const out = await builder.buildReviewerPrompt({
      ...reviewerBase,
      fresh: {
        ...reviewerBase.fresh,
        scalars: {
          fibDirection: "downtrend",
          fibAnchorHigh: 77048.72,
          fibAnchorLow: 76144.71,
          fib_0_382: 76490.04,
          fib_0_500: 76596.72,
          fib_0_618: 76703.39,
          fib_1_272: 75898.82,
          fib_1_618: 75586.03,
        },
      },
      indicatorsMatrix: { fibonacci: { enabled: true } },
    });
    expect(out).toContain("Fib (downtrend)");
    expect(out).toContain("anchorH");
    expect(out).toContain("0.618");
  });

  test("vwap active → reviewer prompt mentions VWAP and price-vs-VWAP", async () => {
    const out = await builder.buildReviewerPrompt({
      ...reviewerBase,
      fresh: {
        ...reviewerBase.fresh,
        scalars: { vwapSession: 76500, priceVsVwapPct: -0.5 },
      },
      indicatorsMatrix: { vwap: { enabled: true } },
    });
    expect(out).toContain("VWAP:");
    expect(out).toContain("-0.50%");
    expect(out).toContain("below");
  });

  test("liquidity_pools active → reviewer prompt mentions nearest pools", async () => {
    const out = await builder.buildReviewerPrompt({
      ...reviewerBase,
      fresh: {
        ...reviewerBase.fresh,
        scalars: {
          equalHighsCount: 2,
          equalLowsCount: 1,
          topEqualHighs: [{ price: 77100, touches: 3 }],
          topEqualLows: [{ price: 76000, touches: 2 }],
        },
      },
      indicatorsMatrix: { liquidity_pools: { enabled: true } },
    });
    expect(out).toContain("Pools:");
    expect(out).toContain("77100");
    expect(out).toContain("76000");
  });

  test("BTC watch config (6 plugins active) → reviewer prompt contains ALL six fragments", async () => {
    const out = await builder.buildReviewerPrompt({
      ...reviewerBase,
      fresh: {
        ...reviewerBase.fresh,
        scalars: {
          rsi: 40.17,
          emaShort: 76635.73,
          emaMid: 76770.49,
          emaLong: 77117.41,
          lastVolume: 136,
          volumeMa20: 188,
          volumePercentile200: 62,
          lastSwingHigh: 77048.72,
          lastSwingLow: 76144.71,
          lastSwingHighAge: 10,
          lastSwingLowAge: 5,
          bosState: "bearish",
          recentHigh: 77317.02,
          recentLow: 76144.71,
          pocPrice: 76750.4,
          fibDirection: "downtrend",
          fibAnchorHigh: 77048.72,
          fibAnchorLow: 76144.71,
          fib_0_382: 76490.04,
          fib_0_500: 76596.72,
          fib_0_618: 76703.39,
          fib_1_272: 75898.82,
          fib_1_618: 75586.03,
        },
      },
      indicatorsMatrix: {
        ema_stack: { enabled: true },
        rsi: { enabled: true },
        volume: { enabled: true },
        swings_bos: { enabled: true },
        structure_levels: { enabled: true },
        fibonacci: { enabled: true },
      },
    });
    // All 6 fragments must be present — historically only 3/6 made it.
    expect(out).toContain("RSI(14)");
    expect(out).toContain("EMA stack");
    expect(out).toContain("Volume:");
    expect(out).toContain("Fib (downtrend)");
    expect(out).toMatch(/BOS|swing/i);
    expect(out).toMatch(/POC|recent|HH|LL/i);
  });
});
