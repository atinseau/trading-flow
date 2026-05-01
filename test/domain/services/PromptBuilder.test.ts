// test/domain/services/PromptBuilder.test.ts
import { describe, expect, test, beforeAll } from "bun:test";
import { PromptBuilder } from "@domain/services/PromptBuilder";
import { FewShotEngine } from "@domain/services/FewShotEngine";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";

const baseArgs = {
  asset: "BTCUSDT", timeframe: "1h", tickAt: new Date("2026-04-30T10:00:00Z"),
  scalars: {}, activeLessons: [], aliveSetups: [], htf: undefined,
};

describe("PromptBuilder.buildDetectorPrompt", () => {
  let builder: PromptBuilder;
  beforeAll(async () => {
    builder = new PromptBuilder(new IndicatorRegistry(), new FewShotEngine());
    await builder.warmUp();
  });

  test("naked: contains 'Naked-mode' and no Indicators block", async () => {
    const out = await builder.buildDetectorPrompt({
      ...baseArgs, indicatorsMatrix: {},
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
});
