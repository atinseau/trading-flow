import { proxyActivities, sleep } from "@temporalio/workflow";
import { getSessionState, type Session, sessionKey } from "../../domain/services/marketSession";
import type { MarketClockActivities } from "./activities";

const activities = proxyActivities<MarketClockActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 5,
    initialInterval: "1s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
  },
});

export function marketClockWorkflowId(session: Session): string {
  return `clock-${sessionKey(session)}`;
}

export type MarketClockInput = { session: Session };

/**
 * Long-running workflow that gates per-watch Temporal Schedules at market
 * session boundaries.
 *
 * Loop:
 *   1. Look up watches in this session.
 *   2. If empty → terminate (last watch on this session was deleted).
 *   3. Compute current open/closed state.
 *   4. Pause or unpause all Schedules accordingly.
 *   5. Sleep until the next transition.
 *
 * `workflow.sleep` has zero compute cost during the sleep window — Temporal
 * holds the timer server-side. Cache hits on cycle: zero token spend.
 */
export async function marketClockWorkflow(input: MarketClockInput): Promise<void> {
  while (true) {
    // Temporal serialises activity return values as JSON, so a Date
    // round-trips as an ISO string. Reconstruct with `new Date()`.
    const now = new Date(await activities.getNow());
    const watches = await activities.listWatchesInSession(input.session);
    if (watches.length === 0) {
      // Last watch on this session was removed; terminate. Bootstrap will
      // restart us if a new watch joins this session later.
      return;
    }

    const state = getSessionState(input.session, now);
    const action: "pause" | "unpause" = state.isOpen ? "unpause" : "pause";
    await activities.applyToSchedules({
      ids: watches.map((w) => `tick-${w.id}`),
      action,
      reason: `market-clock ${sessionKey(input.session)} ${action}`,
    });

    const wakeAt = state.isOpen ? state.nextCloseAt : state.nextOpenAt;
    if (!wakeAt) {
      // always-open session — should never have a clock workflow for it.
      // Defensive return to avoid an infinite hot loop.
      return;
    }

    // Floor at 60s to avoid rapid-fire cycles around boundary edges.
    const sleepMs = Math.max(60_000, wakeAt.getTime() - now.getTime());
    await sleep(sleepMs);
  }
}
