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
