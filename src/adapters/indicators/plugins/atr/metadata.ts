export const ATR_DEFAULT_PARAMS = { period: 14 } as const;

export const atrMetadata = {
  id: "atr" as const,
  displayName: "ATR (14)",
  tag: "volatility" as const,
  shortDescription: "Volatility absolue",
  longDescription: "Average True Range (14) + MA20. ATR-Z200 = compression vs régime normal. Sert à dimensionner les stops.",
  defaultParams: ATR_DEFAULT_PARAMS,
  paramsDescriptor: [
    {
      key: "period",
      kind: "number" as const,
      label: "Period",
      min: 2,
      max: 50,
      step: 1,
      help: "Lookback window for the ATR calculation. Standard = 14.",
    },
  ],
};
