import type { IndicatorId, WatchConfig } from "@domain/schemas/WatchesConfig";
import { KNOWN_INDICATOR_IDS } from "@domain/schemas/WatchesConfig";

export const PRESETS = {
  naked: [] as ReadonlyArray<IndicatorId>,
  recommended: ["ema_stack", "rsi", "volume", "swings_bos", "structure_levels"] as ReadonlyArray<IndicatorId>,
  all: KNOWN_INDICATOR_IDS,
} as const;

export type PresetName = keyof typeof PRESETS;

export function buildIndicatorsMatrix(
  ids: ReadonlyArray<IndicatorId>,
): WatchConfig["indicators"] {
  const matrix: Record<string, { enabled: boolean }> = {};
  for (const id of KNOWN_INDICATOR_IDS) matrix[id] = { enabled: ids.includes(id) };
  return matrix as WatchConfig["indicators"];
}
