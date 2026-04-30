import { describe, expect, test } from "bun:test";
import { buildConfidenceBreakdownSchema } from "@domain/schemas/ConfidenceBreakdown";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

const plugin = (id: string, axes: IndicatorPlugin["breakdownAxes"]): IndicatorPlugin => ({
  id: id as never, displayName: id, tag: "trend",
  shortDescription: "", longDescription: "",
  chartScript: "", chartPane: "price_overlay",
  computeScalars: () => ({}),
  computeSeries: () => ({ kind: "lines", series: {} }),
  scalarSchemaFragment: () => ({}),
  detectorPromptFragment: () => null,
  breakdownAxes: axes,
});

describe("buildConfidenceBreakdownSchema", () => {
  test("naked → { clarity: 0..100 }", () => {
    const s = buildConfidenceBreakdownSchema([], false);
    expect(s.parse({ clarity: 75 })).toEqual({ clarity: 75 });
    expect(() => s.parse({ clarity: 101 })).toThrow();
    expect(() => s.parse({ trigger: 10 })).toThrow();
  });

  test("with plugins, includes trigger axis universally", () => {
    const s = buildConfidenceBreakdownSchema([plugin("rsi", undefined)], false);
    expect(s.parse({ trigger: 10 })).toEqual({ trigger: 10 });
  });

  test("plugin axes accumulate", () => {
    const s = buildConfidenceBreakdownSchema(
      [plugin("volume", ["volume"]), plugin("swings_bos", ["structure"])],
      false,
    );
    expect(s.parse({ trigger: 10, volume: 5, structure: 5 })).toBeDefined();
    expect(() => s.parse({ trigger: 10 })).toThrow();
  });

  test("htf flag adds htf axis", () => {
    const s = buildConfidenceBreakdownSchema([plugin("rsi", undefined)], true);
    expect(s.parse({ trigger: 10, htf: 5 })).toEqual({ trigger: 10, htf: 5 });
  });
});
