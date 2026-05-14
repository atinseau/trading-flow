// Relative import (not @domain alias) is intentional : this file is consumed
// by `setupWorkflow.ts` whose webpack bundle (Temporal workflow sandbox) does
// not honor `@domain/*` aliases for value imports. Sibling helpers like
// `computeTtlExpiresAt.ts` get away with `@domain/*` because they only use
// `import type` for aliased paths. `shouldTriggerFeedback` is a runtime
// symbol, so the path must resolve via Node's standard resolver.
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
