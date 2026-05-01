export const SWINGS_BOS_DEFAULT_PARAMS = { lookback: 3 } as const;

export const swingsBosMetadata = {
  id: "swings_bos" as const,
  displayName: "Swings + Break-of-Structure",
  tag: "structure" as const,
  shortDescription: "Structure swings + BOS",
  longDescription: "Swings hauts/bas (fractale 3 bougies) + état du dernier BOS (haussier / baissier / range). Base de l'analyse de structure.",
  defaultParams: SWINGS_BOS_DEFAULT_PARAMS,
  paramsDescriptor: [
    {
      key: "lookback",
      kind: "number" as const,
      label: "Lookback",
      min: 1,
      max: 10,
      step: 1,
      help: "Number of candles on each side required to confirm a swing high/low. Standard = 2.",
    },
  ],
};
