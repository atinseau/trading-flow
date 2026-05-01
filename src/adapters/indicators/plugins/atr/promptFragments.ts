export function detectorFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
): string | null {
  const atr = s.atr, z = s.atrZScore200;
  if (typeof atr !== "number" || typeof z !== "number") return null;
  const period = typeof params?.period === "number" ? params.period : 14;
  return `**ATR (${period})**: \`${atr.toFixed(2)}\` — z-score (200p): \`${z.toFixed(2)}\` (< -1 compression, > +1.5 exhaustion).`;
}

export function reviewerFragment(
  s: Record<string, unknown>,
  _params?: Record<string, unknown>,
): string | null {
  const atr = s.atr, z = s.atrZScore200;
  if (typeof atr !== "number" || typeof z !== "number") return null;
  return `ATR \`${atr.toFixed(2)}\` (z \`${z.toFixed(2)}\`)`;
}
