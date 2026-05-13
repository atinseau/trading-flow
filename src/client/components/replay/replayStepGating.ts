import type { ReplaySessionStatus } from "./replay-types";

/**
 * Pure decision logic for the replay step / auto controls.
 *
 * Extracted from `replay-controls.tsx` so the four-axis gate (status,
 * mutation in-flight, workflow busy, queued ticks) is unit-testable in
 * isolation. The component just renders the result of these computations.
 *
 * Why each axis matters :
 *
 *  - `status`         : terminal (COMPLETED/FAILED) means the workflow is
 *    gone — no point dispatching anything ; COST_CAPPED needs the user to
 *    raise the cap before continuing.
 *  - `stepInFlight`   : an HTTP /step POST is mid-flight ; firing another
 *    one is a race against React Query's invalidation.
 *  - `workflowBusy`   : the Temporal workflow is inside `processTick`
 *    (Detector / Reviewer / Finalizer activities running). A new signal
 *    just queues behind, so the user thinks "nothing happens" until
 *    everything drains — confusing UX.
 *  - `pendingTicks`   : already-queued signals not yet drained. Same
 *    reasoning as `workflowBusy`.
 *
 * Auto-step has the same gates PLUS it only operates from a strict READY
 * state (PAUSED / COST_CAPPED need explicit user action to resume).
 */

export type StepGatingInput = {
  status: ReplaySessionStatus;
  stepInFlight: boolean;
  workflowBusy: boolean;
  pendingTicks: number;
};

export type StepGatingOutput = {
  /** True iff Step 1 / Step 5 should be disabled. */
  stepDisabled: boolean;
  /** True iff the Auto toggle should be disabled. Stricter than step :
   *  also gated on `status === "READY"`. */
  autoDisabled: boolean;
  /** True iff a "raisonnement en cours" / "tick(s) en file" badge
   *  should be rendered. */
  showBusyBadge: boolean;
  /** True iff the workflow is actually working a tick (spinner badge
   *  message "Raisonnement en cours…"), false if it's just queued ticks
   *  waiting to drain (badge "N tick(s) en file"). */
  workflowActivelyProcessing: boolean;
};

export function computeStepGating(input: StepGatingInput): StepGatingOutput {
  const terminal = input.status === "COMPLETED" || input.status === "FAILED";
  const capped = input.status === "COST_CAPPED";
  const busy = input.workflowBusy || input.pendingTicks > 0;
  const stepDisabled = terminal || capped || input.stepInFlight || busy;
  const autoDisabled = terminal || capped || input.status !== "READY" || busy;
  return {
    stepDisabled,
    autoDisabled,
    showBusyBadge: busy,
    workflowActivelyProcessing: input.workflowBusy,
  };
}
