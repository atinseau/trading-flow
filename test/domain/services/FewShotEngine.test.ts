import { describe, expect, test } from "bun:test";
import { FewShotEngine } from "@domain/services/FewShotEngine";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

const fakePlugin = (id: string, example: string | null): IndicatorPlugin => ({
  id: id as never, displayName: id, tag: "trend",
  shortDescription: "", longDescription: "",
  chartScript: "", chartPane: "price_overlay",
  computeScalars: () => ({}),
  computeSeries: () => ({ kind: "lines", series: {} }),
  scalarSchemaFragment: () => ({}),
  detectorPromptFragment: () => null,
  featuredFewShotExample: example == null ? undefined : () => example,
});

describe("FewShotEngine", () => {
  test("naked returns 2 generic examples only", () => {
    const eng = new FewShotEngine();
    const out = eng.compose([]);
    expect(out.split("### Example").length - 1).toBe(2);
  });

  test("with plugins, appends ≤3 featured examples", () => {
    const eng = new FewShotEngine();
    const out = eng.compose([
      fakePlugin("p1", "### Example 3 — P1\nbody1"),
      fakePlugin("p2", "### Example 4 — P2\nbody2"),
      fakePlugin("p3", "### Example 5 — P3\nbody3"),
      fakePlugin("p4", "### Example 6 — P4\nbody4"),
    ]);
    expect(out).toContain("Example 3");
    expect(out).toContain("Example 4");
    expect(out).toContain("Example 5");
    expect(out).not.toContain("Example 6");
  });

  test("plugins with no featured example contribute nothing", () => {
    const eng = new FewShotEngine();
    const out = eng.compose([fakePlugin("p1", null)]);
    expect(out.split("### Example").length - 1).toBe(2);
  });
});
