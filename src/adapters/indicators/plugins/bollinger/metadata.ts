export const BOLLINGER_DEFAULT_PARAMS = { period: 20, std_mul: 2 } as const;

export const bollingerMetadata = {
  id: "bollinger" as const,
  displayName: "Bollinger Bands",
  tag: "volatility" as const,
  shortDescription: "Volatilité & squeeze",
  longDescription:
    "Bandes ±2σ. Compression (squeeze) = vol comprimée → expansion à venir. Bandwidth-percentile vs 200 bougies = squeeze calibré per-asset.",
  defaultParams: BOLLINGER_DEFAULT_PARAMS,
  paramsDescriptor: [
    {
      key: "period",
      kind: "number" as const,
      label: "Period",
      min: 5,
      max: 100,
      step: 1,
      help: "Lookback window for the moving average and standard deviation. Standard = 20.",
    },
    {
      key: "std_mul",
      kind: "number" as const,
      label: "Std multiplier",
      min: 0.5,
      max: 4,
      step: 0.1,
      help: "Number of standard deviations for band width. Standard = 2.",
    },
  ],
};
