export function detectorFragment(s: Record<string, unknown>): string | null {
  const vwap = s.vwapSession; const pct = s.priceVsVwapPct;
  if (typeof vwap !== "number" || typeof pct !== "number") return null;
  return `**VWAP session**: \`${vwap.toFixed(2)}\` — price vs VWAP: \`${pct.toFixed(2)}%\`.`;
}
