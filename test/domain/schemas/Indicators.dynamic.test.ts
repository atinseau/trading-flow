import { describe, expect, test } from "bun:test";
import { buildIndicatorsSchema } from "@domain/schemas/Indicators";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";

const fakePlugin = (id: string, shape: z.ZodRawShape): IndicatorPlugin => ({
  id: id as never, displayName: id, tag: "trend",
  shortDescription: "", longDescription: "",
  chartScript: "", chartPane: "price_overlay",
  computeScalars: () => ({}),
  computeSeries: () => ({ kind: "lines", series: {} }),
  scalarSchemaFragment: () => shape,
  detectorPromptFragment: () => null,
});

describe("buildIndicatorsSchema", () => {
  test("empty plugins → empty object schema", () => {
    const schema = buildIndicatorsSchema([]);
    expect(schema.parse({})).toEqual({});
  });

  test("merges plugin shapes", () => {
    const a = fakePlugin("rsi", { rsi: z.number() });
    const b = fakePlugin("volume", { lastVolume: z.number(), volumeMa20: z.number() });
    const schema = buildIndicatorsSchema([a, b]);
    expect(schema.parse({ rsi: 50, lastVolume: 100, volumeMa20: 80 })).toEqual({
      rsi: 50, lastVolume: 100, volumeMa20: 80,
    });
    expect(() => schema.parse({ rsi: 50 })).toThrow();
  });
});
