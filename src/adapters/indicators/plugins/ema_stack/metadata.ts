import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";

export const EMA_STACK_DEFAULT_PARAMS = {
  period_short: 20,
  period_mid: 50,
  period_long: 200,
} as const;

export const emaStackMetadata: IndicatorPluginMetadata = {
  id: "ema_stack",
  displayName: "EMA stack (20/50/200)",
  tag: "trend",
  shortDescription: "Tendance multi-horizon",
  longDescription:
    "EMAs 20/50/200 alignées = régime de tendance clair. Inversion de l'empilement = changement de régime.",
  defaultParams: EMA_STACK_DEFAULT_PARAMS,
  paramsDescriptor: [
    {
      key: "period_short",
      kind: "number",
      label: "Short",
      min: 2,
      max: 500,
      step: 1,
      help: "Shortest EMA.",
    },
    {
      key: "period_mid",
      kind: "number",
      label: "Mid",
      min: 2,
      max: 500,
      step: 1,
      help: "Medium EMA.",
    },
    {
      key: "period_long",
      kind: "number",
      label: "Long",
      min: 2,
      max: 500,
      step: 1,
      help: "Longest EMA.",
    },
  ],
};
