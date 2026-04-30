export function detectorFragment(s: Record<string, unknown>): string | null {
  const h = s.recentHigh, l = s.recentLow;
  if (typeof h !== "number" || typeof l !== "number") return null;
  return `**Recent range (50p)**: high=\`${h.toFixed(2)}\` low=\`${l.toFixed(2)}\`.`;
}
