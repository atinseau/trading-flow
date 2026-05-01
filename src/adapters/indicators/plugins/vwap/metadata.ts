export const vwapMetadata = {
  id: "vwap" as const,
  displayName: "VWAP session",
  tag: "trend" as const,
  shortDescription: "VWAP session",
  longDescription:
    "Volume-weighted average price ancré au début de la session UTC. Repère institutionnel — au-dessus = bias long, loin au-dessus = stretched (mean-reversion candidate).",
};
