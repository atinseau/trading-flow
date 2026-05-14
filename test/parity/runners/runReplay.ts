import type { CapturedEvent, PipelineScenario } from "../types";

/**
 * Run a `PipelineScenario` against the replay pipeline.
 *
 * Strategy : assemble an in-memory `ReplayActivityDeps` with stubbed
 * adapters that replay the scenario :
 *
 *   - `runDetectorReplay`  → returns `scenario.ticks[i].detectorVerdict`
 *   - `runReviewerReplay`  → returns `scenario.ticks[i].reviewerVerdict`
 *   - `runFinalizerReplay` → returns `scenario.ticks[i].finalizerDecision`
 *   - `fetchRangeCandles`  → returns `[scenario.ticks[i].candle]`
 *   - `appendReplayEvent`  → captures into `events: CapturedEvent[]`
 *
 * Then : invoke `processTick()` directly per tick (no Temporal sandbox —
 * the replay tick orchestrator is plain async TS and unit-testable).
 *
 * Concrete impl arrives with the first scenario in Task 10.
 */
export async function runReplay(scenario: PipelineScenario): Promise<CapturedEvent[]> {
  throw new Error(
    `runReplay not yet implemented — first scenario in Task 10 drives the build-out. ` +
      `Scenario: ${scenario.name}`,
  );
}
