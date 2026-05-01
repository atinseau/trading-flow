export function detectorFragment(
  s: Record<string, unknown>,
  params?: Record<string, unknown>,
): string | null {
  const lh = s.lastSwingHigh, lha = s.lastSwingHighAge;
  const ll = s.lastSwingLow, lla = s.lastSwingLowAge;
  const bos = s.bosState;
  if (typeof bos !== "string") return null;
  const lookback = typeof params?.lookback === "number" ? params.lookback : 2;
  const fmt = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : "n/a");
  return [
    `**Swings (lb=${lookback})**: last high \`${fmt(lh)}\` (${lha ?? "?"}c ago), last low \`${fmt(ll)}\` (${lla ?? "?"}c ago).`,
    `**BOS state**: \`${bos}\` (bullish/bearish = last structural break, 'none' = ranging).`,
  ].join("\n");
}

export function reviewerFragment(
  s: Record<string, unknown>,
  _params?: Record<string, unknown>,
): string | null {
  const bos = s.bosState;
  if (typeof bos !== "string") return null;
  return `BOS state: \`${bos}\``;
}

export function featuredFewShotExample(): string {
  return `### Example — BOS reaction with swing pivot (event)

Last swing high at 76250 (8c ago) is taken: close 76310. BOS state flipped bullish. Re-test of the broken level held. Last swing low at 75900 (12c ago) anchors invalidation.

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [{
    "type": "bos_reaction",
    "direction": "LONG",
    "pattern_category": "event",
    "expected_maturation_ticks": 2,
    "confidence_breakdown": { "trigger": 16, "structure": 18 },
    "key_levels": { "entry": 76310, "invalidation": 75900, "target": 76800 },
    "initial_score": 34,
    "raw_observation": "BOS bullish on close 76310 > swing high 76250. Re-test held. Invalidation = swing low 75900."
  }],
  "ignore_reason": null
}
\`\`\``;
}
