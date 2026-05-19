import { formatScalarHistory } from "@domain/services/formatScalarHistory";

export function detectorFragment(
  scalars: Record<string, unknown>,
  params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const rsi = scalars.rsi;
  const period = typeof params?.period === "number" ? params.period : 14;
  if (typeof rsi !== "number") return null;
  const series = formatScalarHistory(history?.rsi, { decimals: 2 });
  const lines = [
    `**RSI (${period})**: \`${rsi.toFixed(2)}\` — extreme < 30 / > 70; mid-range neutral.`,
  ];
  if (series.length > 0) lines.push(`  Last values: ${series}`);
  return lines.join("\n");
}

export function reviewerFragment(
  scalars: Record<string, unknown>,
  params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const rsi = scalars.rsi;
  const period = typeof params?.period === "number" ? params.period : 14;
  if (typeof rsi !== "number") return null;
  const series = formatScalarHistory(history?.rsi, { decimals: 2 });
  return series.length > 0
    ? `RSI(${period}) \`${rsi.toFixed(2)}\` (last: ${series})`
    : `RSI(${period}) \`${rsi.toFixed(2)}\``;
}
