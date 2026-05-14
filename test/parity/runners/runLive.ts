import type { TestWorkflowEnvironment } from "@temporalio/testing";
import type { CapturedEvent, PipelineScenario } from "../types";

/**
 * Run a `PipelineScenario` against the live pipeline.
 *
 * Strategy : spin up a `TestWorkflowEnvironment` with fake activities
 * that replay the scenario's per-tick verdicts :
 *
 *   - `runDetector`   → returns `scenario.ticks[i].detectorVerdict`
 *   - `runReviewer`   → returns `scenario.ticks[i].reviewerVerdict` if set
 *   - `runFinalizer`  → returns `scenario.ticks[i].finalizerDecision` if set
 *   - `persistEvent`  → captures the row into `events: CapturedEvent[]`
 *   - other adapters  → minimal stubs (no-op or empty results)
 *
 * Then : start `setupWorkflow` per `scenario.setup`, fan in detector /
 * reviewer / finalizer signals tick-by-tick, optionally signal
 * `priceCheck` from `intraCandlePrices`. After draining, return the
 * captured events.
 *
 * The concrete fake-activity wiring lives here so individual scenarios
 * stay terse. The first scenario (Task 10) drives the build-out — the
 * stub below raises a loud error if invoked beforehand.
 */
export async function runLive(
  scenario: PipelineScenario,
  _env: TestWorkflowEnvironment,
): Promise<CapturedEvent[]> {
  throw new Error(
    `runLive not yet implemented — first scenario in Task 10 drives the build-out. ` +
      `Scenario: ${scenario.name}`,
  );
}
