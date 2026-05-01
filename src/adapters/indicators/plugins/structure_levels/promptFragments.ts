export function detectorFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
): string | null {
  const h = s.recentHigh, l = s.recentLow, poc = s.pocPrice;
  if (typeof h !== "number" || typeof l !== "number" || typeof poc !== "number") return null;
  const window = typeof params?.window === "number" ? params.window : 50;
  return [
    `**Recent range (${window}p)**: high=\`${h.toFixed(2)}\` low=\`${l.toFixed(2)}\`.`,
    `**POC (${window}p)**: \`${poc.toFixed(2)}\` — magnet / mean-reversion anchor.`,
  ].join("\n");
}

export function reviewerFragment(
  s: Record<string, unknown>,
  _params?: Record<string, unknown>,
): string | null {
  const poc = s.pocPrice;
  if (typeof poc !== "number") return null;
  return `POC \`${poc.toFixed(2)}\``;
}
