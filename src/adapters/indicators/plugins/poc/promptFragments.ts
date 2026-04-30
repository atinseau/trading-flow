export function detectorFragment(s: Record<string, unknown>): string | null {
  const poc = s.pocPrice;
  if (typeof poc !== "number") return null;
  return `**POC (50p)**: \`${poc.toFixed(2)}\` — magnet / mean-reversion anchor.`;
}
export function reviewerFragment(s: Record<string, unknown>): string | null {
  const poc = s.pocPrice;
  if (typeof poc !== "number") return null;
  return `POC \`${poc.toFixed(2)}\``;
}
