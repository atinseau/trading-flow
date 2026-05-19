import { formatScalarHistory } from "@domain/services/formatScalarHistory";

export function detectorFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const e20 = s.emaShort,
    e50 = s.emaMid,
    e200 = s.emaLong;
  if (typeof e20 !== "number" || typeof e50 !== "number" || typeof e200 !== "number") return null;
  const ps = typeof params?.period_short === "number" ? params.period_short : 20;
  const pm = typeof params?.period_mid === "number" ? params.period_mid : 50;
  const pl = typeof params?.period_long === "number" ? params.period_long : 200;
  const decimals = pickDecimals(e20);
  const lines = [
    `**EMA stack**: ${ps}=\`${e20.toFixed(decimals)}\` / ${pm}=\`${e50.toFixed(decimals)}\` / ${pl}=\`${e200.toFixed(decimals)}\` — alignment = trend regime.`,
  ];
  const sShort = formatScalarHistory(history?.emaShort, { decimals });
  const sMid = formatScalarHistory(history?.emaMid, { decimals });
  const sLong = formatScalarHistory(history?.emaLong, { decimals });
  if (sShort.length > 0) lines.push(`  EMA${ps} last: ${sShort}`);
  if (sMid.length > 0) lines.push(`  EMA${pm} last: ${sMid}`);
  if (sLong.length > 0) lines.push(`  EMA${pl} last: ${sLong}`);
  return lines.join("\n");
}

export function reviewerFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
  history?: Record<string, ReadonlyArray<number | null>>,
): string | null {
  const e20 = s.emaShort,
    e50 = s.emaMid,
    e200 = s.emaLong;
  if (typeof e20 !== "number" || typeof e50 !== "number" || typeof e200 !== "number") return null;
  const ps = typeof params?.period_short === "number" ? params.period_short : 20;
  const pm = typeof params?.period_mid === "number" ? params.period_mid : 50;
  const pl = typeof params?.period_long === "number" ? params.period_long : 200;
  const decimals = pickDecimals(e20);
  // Stack regime — explicit signal the reviewer system prompt asks for
  // ("EMA short crossing the mid against the setup direction").
  const stackUp = e20 > e50 && e50 > e200;
  const stackDown = e20 < e50 && e50 < e200;
  const regime = stackUp ? "bullish stack" : stackDown ? "bearish stack" : "mixed";
  const base = `EMA stack ${ps}/${pm}/${pl}: \`${e20.toFixed(decimals)}\` / \`${e50.toFixed(decimals)}\` / \`${e200.toFixed(decimals)}\` (${regime})`;
  // Inject a compact tail of the SHORT EMA only (signal of recent
  // momentum shift — long EMA is essentially static at reviewer scope).
  const sShort = formatScalarHistory(history?.emaShort, { decimals, max: 5 });
  return sShort.length > 0 ? `${base} — EMA${ps} last 5: ${sShort}` : base;
}

function pickDecimals(reference: number): number {
  const abs = Math.abs(reference);
  if (abs >= 1000) return 2;
  if (abs >= 10) return 3;
  if (abs >= 1) return 4;
  return 5;
}
