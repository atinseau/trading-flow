import { formatScalarHistory } from "@domain/services/formatScalarHistory";

export function detectorFragment(
  s: Record<string, unknown>,
  _params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const vwap = s.vwapSession;
  const pct = s.priceVsVwapPct;
  if (typeof vwap !== "number" || typeof pct !== "number") return null;
  const lines = [
    `**VWAP session**: \`${vwap.toFixed(2)}\` — price vs VWAP: \`${pct.toFixed(2)}%\`.`,
  ];
  const series = formatScalarHistory(history?.vwap, { decimals: 2 });
  if (series.length > 0) lines.push(`  VWAP last: ${series}`);
  return lines.join("\n");
}

export function reviewerFragment(
  s: Record<string, unknown>,
  _params?: Record<string, unknown>,
): string | null {
  const vwap = s.vwapSession;
  const pct = s.priceVsVwapPct;
  if (typeof vwap !== "number" || typeof pct !== "number") return null;
  return `VWAP: \`${vwap.toFixed(2)}\` price=\`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%\` ${pct >= 0 ? "above" : "below"}`;
}
