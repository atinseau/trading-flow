export function detectorFragment(scalars: Record<string, unknown>): string | null {
  const rsi = scalars.rsi;
  if (typeof rsi !== "number") return null;
  return `**RSI (14)**: \`${rsi.toFixed(2)}\` — extreme < 30 / > 70; mid-range neutral.`;
}

export function reviewerFragment(scalars: Record<string, unknown>): string | null {
  const rsi = scalars.rsi;
  if (typeof rsi !== "number") return null;
  return `RSI \`${rsi.toFixed(2)}\``;
}
