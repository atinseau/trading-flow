import type { ReplaySessionStatus } from "./replay-types";

/**
 * Pick the most authoritative session status.
 *
 * `replay_sessions.status` (the DB row) lags behind the Temporal workflow's
 * in-memory `status` because pause/resume signals flip the workflow's local
 * state instantly but persist to the DB as fire-and-forget activities. So
 * the workflow-state query (`/workflow-state`) is the source of truth while
 * the workflow is alive. We fall back to the DB status when:
 *  - the workflow has terminated (live === null);
 *  - the workflow hasn't started yet (live === null);
 *  - the live value is structurally invalid.
 *
 * Extracted into a pure helper so the lag-correction logic is unit-tested
 * and can't silently regress to "always DB" through future render-loop
 * refactors.
 */

const VALID: ReadonlySet<ReplaySessionStatus> = new Set([
  "READY",
  "PAUSED",
  "COMPLETED",
  "COST_CAPPED",
  "FAILED",
]);

export function pickLiveStatus(
  dbStatus: ReplaySessionStatus,
  liveStatus: ReplaySessionStatus | null | undefined,
): ReplaySessionStatus {
  if (liveStatus && VALID.has(liveStatus)) return liveStatus;
  return dbStatus;
}
