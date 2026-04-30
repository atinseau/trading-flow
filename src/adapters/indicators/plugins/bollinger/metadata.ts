export const bollingerMetadata = {
  id: "bollinger" as const,
  displayName: "Bollinger Bands",
  tag: "volatility" as const,
  shortDescription: "Volatilité & squeeze",
  longDescription:
    "Bandes ±2σ. Compression (squeeze) = vol comprimée → expansion à venir. Bandwidth-percentile vs 200 bougies = squeeze calibré per-asset.",
};
