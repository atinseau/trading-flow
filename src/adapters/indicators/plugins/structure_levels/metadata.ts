import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";

export const structureLevelsMetadata: IndicatorPluginMetadata = {
  id: "structure_levels",
  displayName: "Structure levels (HH/LL + POC + FVG)",
  tag: "structure",
  shortDescription: "High/low récents + POC + Fair Value Gaps",
  longDescription:
    "Plus haut / plus bas des 50 dernières bougies (bornes structurelles), Point of Control (aimant volume profile), et Fair Value Gaps non comblés. " +
    "Trois familles de niveaux à respecter / cibler en sweep / mean-reversion.",
};
