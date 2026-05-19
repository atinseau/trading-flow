import type { IndicatorPluginMetadata, ParamDescriptor } from "@domain/services/IndicatorPlugin";

const PARAMS_DESCRIPTOR: ReadonlyArray<ParamDescriptor> = [
  {
    key: "lookback",
    kind: "number",
    label: "Lookback",
    min: 1,
    max: 10,
    step: 1,
    help: "Bars on each side a candle must dominate to qualify as a swing pivot.",
  },
];

export const fibonacciMetadata: IndicatorPluginMetadata = {
  id: "fibonacci",
  displayName: "Fibonacci",
  tag: "structure",
  shortDescription:
    "Auto-anchored Fibonacci retracements + extensions on the most recent confirmed swing pair.",
  longDescription:
    "Detects the most recent confirmed swing high/low using the same pivot logic as Swings/BOS, then projects 5 Fibonacci levels (0.382, 0.500, 0.618, 1.272, 1.618) between them. Retracement zones (0.382–0.500, 0.500–0.618, 0.618–anchor, anchor–extension) are highlighted as semi-transparent bands so the LLM can see the golden zone at a glance.",
  defaultParams: { lookback: 3 },
  paramsDescriptor: PARAMS_DESCRIPTOR,
};
