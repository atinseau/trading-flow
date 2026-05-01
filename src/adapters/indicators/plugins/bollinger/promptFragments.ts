export function detectorFragment(s: Record<string, unknown>): string | null {
  const bw = s.bbBandwidthPct; const pct = s.bbBandwidthPercentile200;
  if (typeof bw !== "number" || typeof pct !== "number") return null;
  return `**BB bandwidth**: \`${bw.toFixed(2)}%\` — percentile vs last 200 candles: **\`${pct.toFixed(0)}\`** (< 15 = squeeze for THIS asset).`;
}
export function reviewerFragment(s: Record<string, unknown>): string | null {
  const bw = s.bbBandwidthPct;
  if (typeof bw !== "number") return null;
  return `BB bandwidth: \`${bw.toFixed(2)}%\` (squeeze if < 4)`;
}
export function featuredFewShotExample(): string {
  return `### Example — BB squeeze breakout (event)

BB bandwidth percentile 8 (squeeze for THIS asset) resolves bullish on volume percentile 88. BOS confirmed (close 76050 > prior swing high 75900). Aligned with daily uptrend. Target EQH 76470 (×3).

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [{
    "type": "bb_squeeze_breakout",
    "direction": "LONG",
    "pattern_category": "event",
    "expected_maturation_ticks": 2,
    "confidence_breakdown": { "trigger": 18, "structure": 15, "volume": 12 },
    "key_levels": { "entry": 76050, "invalidation": 75880, "target": 76470 },
    "initial_score": 45,
    "raw_observation": "BB bandwidth percentile 8 (squeeze) resolves bullish on volume percentile 88. BOS confirmed."
  }],
  "ignore_reason": null
}
\`\`\``;
}
