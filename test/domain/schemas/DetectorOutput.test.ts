import { describe, expect, test } from "bun:test";
import { buildDetectorOutputSchema } from "@domain/schemas/DetectorOutput";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";

const plugin = (
  id: string,
  axes: IndicatorPlugin["breakdownAxes"],
  shape: z.ZodRawShape = {},
): IndicatorPlugin => ({
  id: id as never,
  displayName: id,
  tag: "trend",
  shortDescription: "",
  longDescription: "",
  chartScript: "",
  chartPane: "price_overlay",
  computeScalars: () => ({}),
  computeSeries: () => ({ kind: "lines", series: {} }),
  scalarSchemaFragment: () => shape,
  detectorPromptFragment: () => null,
  breakdownAxes: axes,
});

const baseSetup = {
  type: "FVG",
  direction: "LONG" as const,
  pattern_category: "event" as const,
  expected_maturation_ticks: 2,
  key_levels: { entry: 100, invalidation: 90, target: 120 },
  initial_score: 60,
  raw_observation: "Bullish FVG at key support",
};

describe("buildDetectorOutputSchema - naked (no plugins)", () => {
  const schema = buildDetectorOutputSchema([], false);

  test("accepts valid naked output with clarity", () => {
    const result = schema.parse({
      corroborations: [],
      new_setups: [{ ...baseSetup, clarity: 75 }],
      ignore_reason: null,
    });
    expect(result.new_setups).toHaveLength(1);
    const setup = result.new_setups[0] as typeof baseSetup & { clarity: number };
    expect(setup.clarity).toBe(75);
    expect(setup.pattern_category).toBe("event");
    expect(setup.expected_maturation_ticks).toBe(2);
  });

  test("rejects naked setup missing clarity", () => {
    expect(() =>
      schema.parse({
        corroborations: [],
        new_setups: [{ ...baseSetup }],
        ignore_reason: null,
      }),
    ).toThrow();
  });

  test("rejects naked setup with confidence_breakdown instead of clarity", () => {
    expect(() =>
      schema.parse({
        corroborations: [],
        new_setups: [{ ...baseSetup, confidence_breakdown: { clarity: 75 } }],
        ignore_reason: null,
      }),
    ).toThrow();
  });

  test("rejects clarity out of range", () => {
    expect(() =>
      schema.parse({
        corroborations: [],
        new_setups: [{ ...baseSetup, clarity: 101 }],
        ignore_reason: null,
      }),
    ).toThrow();
  });

  test("rejects missing pattern_category", () => {
    const { pattern_category: _pc, ...withoutCategory } = baseSetup;
    expect(() =>
      schema.parse({
        corroborations: [],
        new_setups: [{ ...withoutCategory, clarity: 60 }],
        ignore_reason: null,
      }),
    ).toThrow();
  });

  test("rejects expected_maturation_ticks out of range", () => {
    expect(() =>
      schema.parse({
        corroborations: [],
        new_setups: [{ ...baseSetup, clarity: 50, expected_maturation_ticks: 7 }],
        ignore_reason: null,
      }),
    ).toThrow();
  });

  test("new_setups defaults to [] when omitted", () => {
    const result = schema.parse({ ignore_reason: null });
    expect(result.new_setups).toEqual([]);
    expect(result.corroborations).toEqual([]);
  });
});

describe("buildDetectorOutputSchema - equipped (with plugins)", () => {
  const rsiPlugin = plugin("rsi", undefined, { rsi: z.number() });
  const volPlugin = plugin("volume", ["volume"], { lastVolume: z.number() });
  const schema = buildDetectorOutputSchema([rsiPlugin, volPlugin], false);

  test("accepts valid equipped output with confidence_breakdown", () => {
    const result = schema.parse({
      corroborations: [],
      new_setups: [
        {
          ...baseSetup,
          confidence_breakdown: { trigger: 20, volume: 10 },
        },
      ],
      ignore_reason: null,
    });
    expect(result.new_setups).toHaveLength(1);
  });

  test("rejects equipped setup missing confidence_breakdown", () => {
    expect(() =>
      schema.parse({
        corroborations: [],
        new_setups: [{ ...baseSetup }],
        ignore_reason: null,
      }),
    ).toThrow();
  });

  test("rejects equipped setup using clarity instead of confidence_breakdown", () => {
    expect(() =>
      schema.parse({
        corroborations: [],
        new_setups: [{ ...baseSetup, clarity: 70 }],
        ignore_reason: null,
      }),
    ).toThrow();
  });

  test("rejects confidence_breakdown axis value out of range (>25)", () => {
    expect(() =>
      schema.parse({
        corroborations: [],
        new_setups: [
          {
            ...baseSetup,
            confidence_breakdown: { trigger: 26, volume: 10 },
          },
        ],
        ignore_reason: null,
      }),
    ).toThrow();
  });

  test("htf axis added when htfEnabled=true", () => {
    const htfSchema = buildDetectorOutputSchema([rsiPlugin], true);
    const result = htfSchema.parse({
      corroborations: [],
      new_setups: [
        {
          ...baseSetup,
          confidence_breakdown: { trigger: 15, htf: 10 },
        },
      ],
      ignore_reason: null,
    });
    expect(result.new_setups).toHaveLength(1);
  });

  test("rejects invalid pattern_category value", () => {
    expect(() =>
      schema.parse({
        corroborations: [],
        new_setups: [
          {
            ...baseSetup,
            pattern_category: "invalid",
            confidence_breakdown: { trigger: 20, volume: 5 },
          },
        ],
        ignore_reason: null,
      }),
    ).toThrow();
  });

  test("corroboration confidence_delta_suggested capped at 20", () => {
    expect(() =>
      schema.parse({
        corroborations: [
          { setup_id: "abc", evidence: ["bullish"], confidence_delta_suggested: 21 },
        ],
        new_setups: [],
        ignore_reason: null,
      }),
    ).toThrow();
  });
});
