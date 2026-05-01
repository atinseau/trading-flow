export function detectorFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
): string | null {
  const m = s.macd, sig = s.macdSignal, h = s.macdHist;
  if (typeof m !== "number" || typeof sig !== "number" || typeof h !== "number") return null;
  const fast = typeof params?.fast === "number" ? params.fast : 12;
  const slow = typeof params?.slow === "number" ? params.slow : 26;
  const signal = typeof params?.signal === "number" ? params.signal : 9;
  return `**MACD (${fast},${slow},${signal})**: macd=\`${m.toFixed(2)}\` signal=\`${sig.toFixed(2)}\` hist=\`${h.toFixed(2)}\` (hist sign change = momentum shift).`;
}

export function reviewerFragment(
  s: Record<string, unknown>,
  _params?: Record<string, unknown>,
): string | null {
  const h = s.macdHist;
  if (typeof h !== "number") return null;
  return `MACD hist: \`${h.toFixed(2)}\``;
}
