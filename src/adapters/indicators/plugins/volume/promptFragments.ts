import { formatScalarHistory } from "@domain/services/formatScalarHistory";

export function detectorFragment(
  s: Record<string, unknown>,
  _params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const last = s.lastVolume,
    ma = s.volumeMa20,
    pct = s.volumePercentile200;
  if (typeof last !== "number" || typeof ma !== "number" || typeof pct !== "number") return null;
  const lines = [
    `**Volume**: last=\`${last.toFixed(0)}\` / MA20=\`${ma.toFixed(0)}\` — percentile (200p): **\`${pct.toFixed(0)}\`** (> 80 spike, < 20 anemic).`,
  ];
  const volSeries = formatScalarHistory(history?.volume, { decimals: 0 });
  const maSeries = formatScalarHistory(history?.volumeMa20, { decimals: 0 });
  if (volSeries.length > 0) lines.push(`  Volume last: ${volSeries}`);
  if (maSeries.length > 0) lines.push(`  MA20 last: ${maSeries}`);
  return lines.join("\n");
}

export function reviewerFragment(
  s: Record<string, unknown>,
  _params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const last = s.lastVolume,
    ma = s.volumeMa20,
    pct = s.volumePercentile200;
  if (typeof last !== "number" || typeof ma !== "number" || typeof pct !== "number") return null;
  // Reviewer system prompt names "Volume drying up on the directional leg"
  // as a WEAKEN trigger — explicitly surface the ratio + drift so the
  // LLM can reference it without re-deriving from history.
  const ratio = ma > 0 ? last / ma : 0;
  const base = `Volume: last=\`${last.toFixed(0)}\` MA20=\`${ma.toFixed(0)}\` ratio=\`${ratio.toFixed(2)}\` pct200=\`${pct.toFixed(0)}\``;
  const tail = formatScalarHistory(history?.volume, { decimals: 0, max: 5 });
  return tail.length > 0 ? `${base} — last 5: ${tail}` : base;
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
