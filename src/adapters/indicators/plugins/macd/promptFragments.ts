import { formatScalarHistory } from "@domain/services/formatScalarHistory";

export function detectorFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const m = s.macd,
    sig = s.macdSignal,
    h = s.macdHist;
  if (typeof m !== "number" || typeof sig !== "number" || typeof h !== "number") return null;
  const fast = typeof params?.fast === "number" ? params.fast : 12;
  const slow = typeof params?.slow === "number" ? params.slow : 26;
  const signal = typeof params?.signal === "number" ? params.signal : 9;
  const lines = [
    `**MACD (${fast},${slow},${signal})**: macd=\`${m.toFixed(2)}\` signal=\`${sig.toFixed(2)}\` hist=\`${h.toFixed(2)}\` (hist sign change = momentum shift).`,
  ];
  const histSeries = formatScalarHistory(history?.hist, { decimals: 2 });
  if (histSeries.length > 0) lines.push(`  Hist last: ${histSeries}`);
  return lines.join("\n");
}

export function reviewerFragment(
  s: Record<string, unknown>,
  _params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const h = s.macdHist;
  if (typeof h !== "number") return null;
  const histSeries = formatScalarHistory(history?.hist, { decimals: 2 });
  return histSeries.length > 0
    ? `MACD hist: \`${h.toFixed(2)}\` (last: ${histSeries})`
    : `MACD hist: \`${h.toFixed(2)}\``;
}
