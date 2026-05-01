export const MACD_DEFAULT_PARAMS = { fast: 12, slow: 26, signal: 9 } as const;

export const macdMetadata = {
  id: "macd" as const,
  displayName: "MACD (12,26,9)",
  tag: "momentum" as const,
  shortDescription: "Convergence/divergence des EMAs",
  longDescription: "MACD (12,26,9). Croisement de l'histogramme de signe = pivot momentum. Histogramme accélérant = momentum se renforçant.",
  defaultParams: MACD_DEFAULT_PARAMS,
  paramsDescriptor: [
    {
      key: "fast",
      kind: "number" as const,
      label: "Fast",
      min: 2,
      max: 50,
      step: 1,
      help: "Fast EMA period. Standard = 12.",
    },
    {
      key: "slow",
      kind: "number" as const,
      label: "Slow",
      min: 2,
      max: 50,
      step: 1,
      help: "Slow EMA period. Standard = 26. Must be > fast.",
    },
    {
      key: "signal",
      kind: "number" as const,
      label: "Signal",
      min: 2,
      max: 50,
      step: 1,
      help: "Signal line smoothing period. Standard = 9.",
    },
  ],
};
