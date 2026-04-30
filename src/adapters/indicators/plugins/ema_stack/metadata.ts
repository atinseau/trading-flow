import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";
export const emaStackMetadata: IndicatorPluginMetadata = {
  id: "ema_stack",
  displayName: "EMA stack (20/50/200)",
  tag: "trend",
  shortDescription: "Tendance multi-horizon",
  longDescription:
    "EMAs 20/50/200 alignées = régime de tendance clair. Inversion de l'empilement = changement de régime.",
};
