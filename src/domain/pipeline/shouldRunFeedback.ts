// Relative import matches the sibling-module convention used elsewhere in
// `src/domain/`. The `@domain/feedback/closeOutcome` alias also works for
// runtime imports inside the workflow bundle — `replaySessionWorkflow.ts`
// and `schedulerWorkflow.ts` use the alias for value imports and ship
// fine. Pick either ; the sibling-relative form is slightly shorter.
import { type CloseOutcome, shouldTriggerFeedback } from "../feedback/closeOutcome";

export type ShouldRunFeedbackInput = {
  closeOutcome: CloseOutcome;
  /** From `watch.feedback.enabled`, snapshotted into InitialEvidence at setup
   *  creation so concurrent watch edits can't retroactively flip a setup's
   *  feedback fate. */
  watchFeedbackEnabled: boolean;
  /** Replay-only: `"run"` (default) or `"skip"`. Undefined in live. */
  sessionFeedbackMode?: "run" | "skip";
};

/**
 * Unified gate for the feedback loop. Live and replay must agree on when
 * the feedbackLoopWorkflow / runFeedbackAnalysisReplay fires.
 *
 * Drift G : replay used to gate only on sessionFeedbackMode, ignoring
 * `watch.feedback.enabled`. A watch with feedback turned off was still
 * producing lesson proposals in replay sessions.
 */
export function shouldRunFeedback(input: ShouldRunFeedbackInput): boolean {
  if (!input.watchFeedbackEnabled) return false;
  if ((input.sessionFeedbackMode ?? "run") === "skip") return false;
  return shouldTriggerFeedback(input.closeOutcome);
}
