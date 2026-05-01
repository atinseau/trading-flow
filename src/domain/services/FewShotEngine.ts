// src/domain/services/FewShotEngine.ts
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

const GENERIC_DOUBLE_BOTTOM = `
### Example 1 — Visual double-bottom by eye

Two visible lows printed at similar levels, separated by a few candles. The second low closes higher than the first → potential reversal forming.

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [{
    "type": "double_bottom",
    "direction": "LONG",
    "pattern_category": "accumulation",
    "expected_maturation_ticks": 4,
    "key_levels": { "entry": null, "invalidation": null, "target": null },
    "raw_observation": "Two lows at similar levels, second close higher than first — accumulation forming."
  }],
  "ignore_reason": null
}
\`\`\`
`.trim();

const GENERIC_RANGE_CHOP = `
### Example 2 — Range chop, ignore

Sideways tight range, no clean swing structure, no decisive close. Nothing actionable.

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [],
  "ignore_reason": "Mid-range chop, no clean structure or trigger candle."
}
\`\`\`
`.trim();

export class FewShotEngine {
  private readonly maxFeatured = 4;

  compose(plugins: ReadonlyArray<IndicatorPlugin>): string {
    const featured = plugins
      .map((p) => p.featuredFewShotExample?.())
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .slice(0, this.maxFeatured);
    return [GENERIC_DOUBLE_BOTTOM, GENERIC_RANGE_CHOP, ...featured].join("\n\n");
  }
}
