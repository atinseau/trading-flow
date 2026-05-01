import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";

export const RSI_DEFAULT_PARAMS = { period: 14 } as const;

export const rsiMetadata: IndicatorPluginMetadata = {
  id: "rsi",
  displayName: "RSI",
  tag: "momentum",
  shortDescription: "Momentum / surachat-survente",
  longDescription:
    "Oscillateur 0-100. Extrêmes < 30 / > 70 signalent surextension. " +
    "Divergences entre prix et RSI = retournement potentiel.",
  defaultParams: RSI_DEFAULT_PARAMS,
  paramsDescriptor: [
    {
      key: "period",
      kind: "number",
      label: "Period",
      min: 2,
      max: 50,
      step: 1,
      help: "Lookback window for the RSI calculation. Standard = 14.",
    },
  ],
};
