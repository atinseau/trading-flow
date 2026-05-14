/**
 * Pure decision logic for whether to fan out a `review` signal to an alive
 * setup on each detector tick.
 *
 * Extracted from `schedulerWorkflow.runOneTick` so the truth table is
 * directly unit-testable. Pre-fix, the workflow unconditionally skipped
 * the review signal for any corroborated setup — meaning the config flag
 * `optimization.reviewer_skip_when_detector_corroborated` (defaults to
 * `false` so the reviewer is part of the pipeline by default) was never
 * read. The result in production was 0 reviewer LLM calls in 7 days while
 * detector + finalizer ran normally.
 *
 * Contract :
 *
 *   reviewerSkipOnCorroborate = true   →  skip reviewer when corroborated
 *                                          (cost optimization — opt-in)
 *   reviewerSkipOnCorroborate = false  →  always run reviewer
 *                                          (default — reviewer is the
 *                                           quality gate the finalizer
 *                                           relies on)
 */

export function shouldSendReviewSignal(args: {
  setupId: string;
  corroboratedIds: ReadonlySet<string>;
  reviewerSkipOnCorroborate: boolean;
}): boolean {
  // Detector did NOT corroborate this setup this tick → reviewer always runs
  // (it's the only path that updates the setup's quality score on this tick).
  if (!args.corroboratedIds.has(args.setupId)) return true;

  // Corroborated. The optimization flag decides whether the score bump from
  // the detector's corroboration is "enough" to skip the reviewer's
  // independent quality evaluation, or whether the reviewer must still run
  // to keep its score signal current.
  return !args.reviewerSkipOnCorroborate;
}
