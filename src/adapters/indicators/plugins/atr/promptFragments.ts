import { formatScalarHistory } from "@domain/services/formatScalarHistory";

export function detectorFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const atr = s.atr,
    z = s.atrZScore200;
  if (typeof atr !== "number" || typeof z !== "number") return null;
  const period = typeof params?.period === "number" ? params.period : 14;
  const lines = [
    `**ATR (${period})**: \`${atr.toFixed(2)}\` — z-score (200p): \`${z.toFixed(2)}\` (< -1 compression, > +1.5 exhaustion).`,
  ];
  const atrSeries = formatScalarHistory(history?.atr, { decimals: 2 });
  if (atrSeries.length > 0) lines.push(`  ATR last: ${atrSeries}`);
  return lines.join("\n");
}

export function reviewerFragment(
  s: Record<string, unknown>,
  _params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const atr = s.atr,
    z = s.atrZScore200;
  if (typeof atr !== "number" || typeof z !== "number") return null;
  const atrSeries = formatScalarHistory(history?.atr, { decimals: 2 });
  return atrSeries.length > 0
    ? `ATR \`${atr.toFixed(2)}\` (z \`${z.toFixed(2)}\`, last: ${atrSeries})`
    : `ATR \`${atr.toFixed(2)}\` (z \`${z.toFixed(2)}\`)`;
}
