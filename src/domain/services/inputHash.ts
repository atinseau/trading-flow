import { createHash } from "node:crypto";
import { REGISTRY } from "@adapters/indicators/IndicatorRegistry";

export type HashInput = {
  setupId: string;
  promptVersion: string;
  ohlcvSnapshot: string;
  chartUri: string;
  indicators: Record<string, number>;
  /**
   * Per-plugin params from the watch config's indicators matrix.
   * Params equal to plugin defaults are stripped before hashing so that
   * an explicit `{ period: 14 }` and an omitted `params` produce the same
   * cache key.
   */
  indicatorParams?: Record<string, Record<string, unknown> | undefined>;
  /**
   * Sorted (ASC) IDs of ACTIVE lessons injected into the prompt. Including the
   * lesson set in the hash means a different active-lesson cohort produces a
   * different inputHash, so a stale cached verdict isn't replayed when the
   * watch's lesson library changes between runs. Optional for backward
   * compatibility with callers that don't inject lessons (Phase 10+).
   */
  activeLessonIds?: string[];
};

/**
 * Strips params that are equal to a plugin's defaultParams so that
 * `{ period: 14 }` and `undefined` hash identically (cache-friendly).
 */
function normalizeIndicatorParams(
  params: Record<string, Record<string, unknown> | undefined>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, p] of Object.entries(params)) {
    if (!p) continue;
    const plugin = REGISTRY.find((pl) => pl.id === id);
    const isDefault =
      !plugin?.defaultParams ||
      JSON.stringify(p) === JSON.stringify(plugin.defaultParams);
    if (!isDefault) {
      out[id] = p;
    }
  }
  return out;
}

export function computeInputHash(input: HashInput): string {
  const sortedIndicators = Object.fromEntries(
    Object.entries(input.indicators).sort(([a], [b]) => a.localeCompare(b)),
  );
  const normalizedParams = input.indicatorParams
    ? normalizeIndicatorParams(input.indicatorParams)
    : {};
  const sortedParams = Object.fromEntries(
    Object.entries(normalizedParams).sort(([a], [b]) => a.localeCompare(b)),
  );
  const canonical = JSON.stringify({
    setupId: input.setupId,
    promptVersion: input.promptVersion,
    ohlcvSnapshot: input.ohlcvSnapshot,
    chartUri: input.chartUri,
    indicators: sortedIndicators,
    indicatorParams: sortedParams,
    activeLessonIds: input.activeLessonIds ?? [],
  });
  return createHash("sha256").update(canonical).digest("hex");
}
