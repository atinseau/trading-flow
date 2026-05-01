export function detectorFragment(
  scalars: Record<string, unknown>,
  params?: Record<string, unknown>,
): string | null {
  const rsi = scalars.rsi;
  const period = typeof params?.period === "number" ? params.period : 14;
  if (typeof rsi !== "number") return null;
  return `**RSI (${period})**: \`${rsi.toFixed(2)}\` — extreme < 30 / > 70; mid-range neutral.`;
}

export function reviewerFragment(
  scalars: Record<string, unknown>,
  params?: Record<string, unknown>,
): string | null {
  const rsi = scalars.rsi;
  const period = typeof params?.period === "number" ? params.period : 14;
  if (typeof rsi !== "number") return null;
  return `RSI(${period}) \`${rsi.toFixed(2)}\``;
}
