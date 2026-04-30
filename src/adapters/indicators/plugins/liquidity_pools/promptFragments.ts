export function detectorFragment(s: Record<string, unknown>): string | null {
  const ah = s.topEqualHighs, al = s.topEqualLows;
  if (!Array.isArray(ah) || !Array.isArray(al)) return null;
  const fmt = (arr: { price: number; touches: number }[]) =>
    arr.length === 0 ? "(none)" : arr.map((e) => `\`${e.price.toFixed(2)}\` ×${e.touches}`).join(", ");
  return `**Liquidity pools** (top equal-pivot clusters):\n  - Above: ${fmt(ah as never)}\n  - Below: ${fmt(al as never)}`;
}
