import { formatScalarHistory } from "@domain/services/formatScalarHistory";

export function detectorFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const bw = s.bbBandwidthPct;
  const pct = s.bbBandwidthPercentile200;
  if (typeof bw !== "number" || typeof pct !== "number") return null;
  const period = typeof params?.period === "number" ? params.period : 20;
  const stdMul = typeof params?.std_mul === "number" ? params.std_mul : 2;
  const lines = [
    `**BB(${period}, ${stdMul}σ) bandwidth**: \`${bw.toFixed(2)}%\` — percentile vs last 200 candles: **\`${pct.toFixed(0)}\`** (< 15 = squeeze for THIS asset).`,
  ];
  const upperSeries = formatScalarHistory(history?.upper, { decimals: 2 });
  const lowerSeries = formatScalarHistory(history?.lower, { decimals: 2 });
  if (upperSeries.length > 0) lines.push(`  BB up last: ${upperSeries}`);
  if (lowerSeries.length > 0) lines.push(`  BB lo last: ${lowerSeries}`);
  return lines.join("\n");
}

export function reviewerFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const bw = s.bbBandwidthPct;
  if (typeof bw !== "number") return null;
  const period = typeof params?.period === "number" ? params.period : 20;
  const stdMul = typeof params?.std_mul === "number" ? params.std_mul : 2;
  const upperSeries = formatScalarHistory(history?.upper, { decimals: 2, max: 5 });
  return upperSeries.length > 0
    ? `BB(${period}, ${stdMul}σ) bandwidth: \`${bw.toFixed(2)}%\` (BB up last 5: ${upperSeries})`
    : `BB(${period}, ${stdMul}σ) bandwidth: \`${bw.toFixed(2)}%\` (squeeze if < 4)`;
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
