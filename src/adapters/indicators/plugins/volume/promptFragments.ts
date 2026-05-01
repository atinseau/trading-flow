export function detectorFragment(s: Record<string, unknown>): string | null {
  const last = s.lastVolume, ma = s.volumeMa20, pct = s.volumePercentile200;
  if (typeof last !== "number" || typeof ma !== "number" || typeof pct !== "number") return null;
  return `**Volume**: last=\`${last.toFixed(0)}\` / MA20=\`${ma.toFixed(0)}\` — percentile (200p): **\`${pct.toFixed(0)}\`** (> 80 spike, < 20 anemic).`;
}
export function featuredFewShotExample(): string {
  return `### Example — Volume climax reversal (accumulation)

Volume percentile 96 on the latest down candle (capitulation), but follow-through candle volume drops to percentile 32. Wick rejection at the recent low. Mean-reversion setup forming.

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [{
    "type": "volume_climax",
    "direction": "LONG",
    "pattern_category": "accumulation",
    "expected_maturation_ticks": 3,
    "confidence_breakdown": { "trigger": 12, "volume": 18 },
    "key_levels": { "entry": 75450, "invalidation": 75250, "target": 75900 },
    "initial_score": 30,
    "raw_observation": "Volume percentile 96 on capitulation candle, follow-through 32 — exhausted seller. Wick rejection at recent low."
  }],
  "ignore_reason": null
}
\`\`\``;
}
