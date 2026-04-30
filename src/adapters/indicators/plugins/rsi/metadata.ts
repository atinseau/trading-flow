import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";

export const rsiMetadata: IndicatorPluginMetadata = {
  id: "rsi",
  displayName: "RSI",
  tag: "momentum",
  shortDescription: "Momentum / surachat-survente",
  longDescription:
    "Oscillateur 0-100. Extrêmes < 30 / > 70 signalent surextension. " +
    "Divergences entre prix et RSI = retournement potentiel.",
};
