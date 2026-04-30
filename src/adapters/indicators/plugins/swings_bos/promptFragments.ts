export function detectorFragment(s: Record<string, unknown>): string | null {
  const lh = s.lastSwingHigh, lha = s.lastSwingHighAge;
  const ll = s.lastSwingLow, lla = s.lastSwingLowAge;
  const bos = s.bosState;
  if (typeof bos !== "string") return null;
  const fmt = (v: unknown) => typeof v === "number" ? v.toFixed(2) : "n/a";
  return [
    `**Swings**: last high \`${fmt(lh)}\` (${lha ?? "?"}c ago), last low \`${fmt(ll)}\` (${lla ?? "?"}c ago).`,
    `**BOS state**: \`${bos}\` (bullish/bearish = last structural break, 'none' = ranging).`,
  ].join("\n");
}
export function reviewerFragment(s: Record<string, unknown>): string | null {
  const bos = s.bosState;
  if (typeof bos !== "string") return null;
  return `BOS state: \`${bos}\``;
}
