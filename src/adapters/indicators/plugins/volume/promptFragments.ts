export function detectorFragment(s: Record<string, unknown>): string | null {
  const last = s.lastVolume, ma = s.volumeMa20, pct = s.volumePercentile200;
  if (typeof last !== "number" || typeof ma !== "number" || typeof pct !== "number") return null;
  return `**Volume**: last=\`${last.toFixed(0)}\` / MA20=\`${ma.toFixed(0)}\` — percentile (200p): **\`${pct.toFixed(0)}\`** (> 80 spike, < 20 anemic).`;
}
