export function detectorFragment(s: Record<string, unknown>): string | null {
  const m = s.macd, sig = s.macdSignal, h = s.macdHist;
  if (typeof m !== "number" || typeof sig !== "number" || typeof h !== "number") return null;
  return `**MACD**: macd=\`${m.toFixed(2)}\` signal=\`${sig.toFixed(2)}\` hist=\`${h.toFixed(2)}\` (hist sign change = momentum shift).`;
}
export function reviewerFragment(s: Record<string, unknown>): string | null {
  const h = s.macdHist;
  if (typeof h !== "number") return null;
  return `MACD hist: \`${h.toFixed(2)}\``;
}
