export function detectorFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
): string | null {
  const e20 = s.emaShort, e50 = s.emaMid, e200 = s.emaLong;
  if (typeof e20 !== "number" || typeof e50 !== "number" || typeof e200 !== "number") return null;
  const ps = typeof params?.period_short === "number" ? params.period_short : 20;
  const pm = typeof params?.period_mid === "number" ? params.period_mid : 50;
  const pl = typeof params?.period_long === "number" ? params.period_long : 200;
  return `**EMA stack**: ${ps}=\`${e20.toFixed(2)}\` / ${pm}=\`${e50.toFixed(2)}\` / ${pl}=\`${e200.toFixed(2)}\` — alignment = trend regime.`;
}
