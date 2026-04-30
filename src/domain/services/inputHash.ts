import { createHash } from "node:crypto";

export type HashInput = {
  setupId: string;
  promptVersion: string;
  ohlcvSnapshot: string;
  chartUri: string;
  indicators: Record<string, number>;
  /**
   * Sorted (ASC) IDs of ACTIVE lessons injected into the prompt. Including the
   * lesson set in the hash means a different active-lesson cohort produces a
   * different inputHash, so a stale cached verdict isn't replayed when the
   * watch's lesson library changes between runs. Optional for backward
   * compatibility with callers that don't inject lessons (Phase 10+).
   */
  activeLessonIds?: string[];
};

export function computeInputHash(input: HashInput): string {
  const sortedIndicators = Object.fromEntries(
    Object.entries(input.indicators).sort(([a], [b]) => a.localeCompare(b)),
  );
  const canonical = JSON.stringify({
    setupId: input.setupId,
    promptVersion: input.promptVersion,
    ohlcvSnapshot: input.ohlcvSnapshot,
    chartUri: input.chartUri,
    indicators: sortedIndicators,
    activeLessonIds: input.activeLessonIds ?? [],
  });
  return createHash("sha256").update(canonical).digest("hex");
}
