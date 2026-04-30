export function detectorFragment(s: Record<string, unknown>): string | null {
  const e20 = s.ema20, e50 = s.ema50, e200 = s.ema200;
  if (typeof e20 !== "number" || typeof e50 !== "number" || typeof e200 !== "number") return null;
  return `**EMA stack**: 20=\`${e20.toFixed(2)}\` / 50=\`${e50.toFixed(2)}\` / 200=\`${e200.toFixed(2)}\` — alignment = trend regime.`;
}
