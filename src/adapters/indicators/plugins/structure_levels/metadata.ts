import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";

export const STRUCTURE_LEVELS_DEFAULT_PARAMS = { window: 50, poc_buckets: 30 } as const;

export const structureLevelsMetadata: IndicatorPluginMetadata = {
  id: "structure_levels",
  displayName: "Structure levels (HH/LL + POC + FVG)",
  tag: "structure",
  shortDescription: "High/low récents + POC + Fair Value Gaps",
  longDescription:
    "Plus haut / plus bas des 50 dernières bougies (bornes structurelles), Point of Control (aimant volume profile), et Fair Value Gaps non comblés. " +
    "Trois familles de niveaux à respecter / cibler en sweep / mean-reversion.",
  defaultParams: STRUCTURE_LEVELS_DEFAULT_PARAMS,
  paramsDescriptor: [
    {
      key: "window",
      kind: "number",
      label: "Window",
      min: 10,
      max: 200,
      step: 1,
      help: "Number of recent candles used to compute the HH/LL range and POC. Standard = 50.",
    },
    {
      key: "poc_buckets",
      kind: "number",
      label: "POC buckets",
      min: 10,
      max: 100,
      step: 1,
      help: "Number of price buckets for volume profile POC computation. Standard = 30.",
    },
  ],
};
