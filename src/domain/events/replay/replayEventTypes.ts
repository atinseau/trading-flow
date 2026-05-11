import { z } from "zod";

/**
 * Replay-specific event payloads. These events live ONLY in
 * `replay_events` (never in the live `events` table). They extend the
 * live event types to capture replay-specific situations :
 *
 * - `DetectorTickProcessed` : emitted on every tick where the Detector
 *   was invoked, even if it returned an `ignore_reason`. Provides a
 *   continuous trace for UI inspection of the bot's per-tick reasoning.
 * - `ReplayMeta` : meta events about the session itself (paused, cost
 *   capped, resumed). Distinct stage `replay-meta`.
 * - `FeedbackLessonProposed` : emitted by the feedback loop in replay
 *   mode when it produces a lesson. The lesson is captured in the
 *   payload here ; it is NEVER written to the live `lessons` table
 *   (see spec §10 invariant 9). A future "Promouvoir en prod" button
 *   may copy these into the live `lessons` table after user validation.
 */

/** Detector ran at this tick. May or may not have produced a setup. */
export const DetectorTickProcessedPayload = z.object({
  ignoreReason: z.string().nullable(),
  reasoning: z.string().optional(),
});

/** Session-level meta event. */
export const ReplayMetaPayload = z.object({
  kind: z.enum(["paused", "resumed", "cost_capped", "failed", "reset"]),
  reason: z.string().optional(),
});

/** A lesson proposed by the feedback loop during replay (never auto-promoted). */
export const FeedbackLessonProposedPayload = z.object({
  action: z.enum(["CREATE", "REINFORCE", "REFINE", "DEPRECATE"]),
  title: z.string(),
  body: z.string(),
  rationale: z.string(),
  /** Setup whose close triggered this feedback analysis. */
  sourceTradeSetupId: z.uuid(),
  /** For REFINE/DEPRECATE actions targeting an existing lesson. */
  supersedesLessonId: z.uuid().optional(),
});

export type DetectorTickProcessedData = z.infer<typeof DetectorTickProcessedPayload>;
export type ReplayMetaData = z.infer<typeof ReplayMetaPayload>;
export type FeedbackLessonProposedData = z.infer<typeof FeedbackLessonProposedPayload>;
