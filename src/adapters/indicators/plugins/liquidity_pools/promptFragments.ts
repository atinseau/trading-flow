export function detectorFragment(s: Record<string, unknown>): string | null {
  const ah = s.topEqualHighs, al = s.topEqualLows;
  if (!Array.isArray(ah) || !Array.isArray(al)) return null;
  const fmt = (arr: { price: number; touches: number }[]) =>
    arr.length === 0 ? "(none)" : arr.map((e) => `\`${e.price.toFixed(2)}\` ×${e.touches}`).join(", ");
  return `**Liquidity pools** (top equal-pivot clusters):\n  - Above: ${fmt(ah as never)}\n  - Below: ${fmt(al as never)}`;
}
export function featuredFewShotExample(): string {
  return `### Example — Sweep + reclaim on EQH cluster (event)

Wick took EQH 76250×3 (3-touch cluster) at 76340 then closed back below at 76200. Volume on the wick: percentile 96 (absorption). Daily downtrend + crowded long funding = squeeze fuel.

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [{
    "type": "liquidity_sweep",
    "direction": "SHORT",
    "pattern_category": "event",
    "expected_maturation_ticks": 1,
    "confidence_breakdown": { "trigger": 22, "structure": 18 },
    "key_levels": { "entry": 76200, "invalidation": 76360, "target": 75300 },
    "initial_score": 40,
    "raw_observation": "Sweep+reclaim on EQH 76250×3: wick 76340 closed 76200. Volume percentile 96 on sweep (absorption)."
  }],
  "ignore_reason": null
}
\`\`\``;
}
