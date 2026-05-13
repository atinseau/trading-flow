import type { StoredReplayEvent } from "@domain/ports/ReplayEventStore";
import { deriveOutcome, type Outcome } from "@domain/services/deriveOutcome";
import { deriveTradeOutcome } from "@domain/services/deriveTradeOutcome";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type SetupProjection = {
  setupId: string;
  status: SetupStatus;
  direction: "LONG" | "SHORT" | null;
  patternHint: string | null;
  currentScore: number;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number[] | null;
  invalidationLevel: number | null;
  closedAt: Date | null;
  outcome: Outcome | null;
  rMultiple: number | null;
  pnlPct: number | null;
  firstEventSeq: number;
  lastEventSeq: number;
  firstEventAt: Date;
  lastEventAt: Date;
  eventCount: number;
};

/**
 * Folds a session's replay_events into one projection per setup_id.
 * Pure: deterministic from the events list. Reuses the live domain
 * helpers `deriveOutcome` and `deriveTradeOutcome` to keep replay
 * statistics aligned with live trade outcome semantics.
 *
 * Events without a setupId (session-meta or detector-tick-without-setup)
 * are ignored — they belong to the session as a whole, not to a setup.
 */
export function projectSetupsFromEvents(
  events: ReadonlyArray<StoredReplayEvent>,
): SetupProjection[] {
  const bySetup = new Map<string, StoredReplayEvent[]>();
  for (const e of events) {
    if (!e.setupId) continue;
    const arr = bySetup.get(e.setupId);
    if (arr) arr.push(e);
    else bySetup.set(e.setupId, [e]);
  }

  const projections: SetupProjection[] = [];
  for (const [setupId, evts] of bySetup) {
    evts.sort((a, b) => a.sequence - b.sequence);
    projections.push(foldSetup(setupId, evts));
  }
  // Order: most recently active first.
  projections.sort((a, b) => b.lastEventAt.getTime() - a.lastEventAt.getTime());
  return projections;
}

function foldSetup(setupId: string, evts: StoredReplayEvent[]): SetupProjection {
  let status: SetupStatus = "CANDIDATE";
  let direction: "LONG" | "SHORT" | null = null;
  let patternHint: string | null = null;
  let currentScore = 0;
  let entry: number | null = null;
  let stopLoss: number | null = null;
  let takeProfit: number[] | null = null;
  let invalidationLevel: number | null = null;
  let closedAt: Date | null = null;

  for (const e of evts) {
    // Track status transitions via statusAfter (the workflow tags every
    // event with statusBefore/statusAfter so we don't have to re-implement
    // the state machine here).
    if (e.statusAfter) status = e.statusAfter as SetupStatus;
    if (e.scoreAfter !== null && e.scoreAfter !== undefined) currentScore = e.scoreAfter;

    const payload = e.payload;
    if (payload.type === "SetupCreated") {
      direction = payload.data.direction;
      patternHint = payload.data.pattern;
      invalidationLevel = payload.data.keyLevels.invalidation;
      entry = payload.data.keyLevels.entry ?? null;
    }
    if (payload.type === "Confirmed") {
      entry = payload.data.entry;
      stopLoss = payload.data.stopLoss;
      takeProfit = payload.data.takeProfit;
    }
    // Terminal events: snapshot the time as closedAt.
    if (
      e.type === "SLHit" ||
      e.type === "TPHit" ||
      e.type === "Invalidated" ||
      e.type === "Expired" ||
      e.type === "Killed" ||
      e.type === "Rejected"
    ) {
      // Use the LAST terminal event's time as closedAt (for partial TPs we
      // keep updating until the final close event).
      closedAt = e.occurredAt;
    }
  }

  // Derive outcome and R-multiple using the existing live helpers.
  const outcome = deriveOutcome(
    status,
    evts.map((e) => ({ type: e.type, sequence: e.sequence })),
  );

  // For trade metrics, deriveTradeOutcome needs the full payload events.
  const trade = direction
    ? deriveTradeOutcome({
        direction,
        events: evts.map((e) => ({
          type: e.type,
          sequence: e.sequence,
          payload: e.payload,
        })),
      })
    : null;

  const first = evts[0]!;
  const last = evts[evts.length - 1]!;

  return {
    setupId,
    status,
    direction,
    patternHint,
    currentScore,
    entry,
    stopLoss,
    takeProfit,
    invalidationLevel,
    closedAt,
    outcome,
    rMultiple: trade?.metrics.rMultiple ?? null,
    pnlPct: trade?.metrics.pnlPct ?? null,
    firstEventSeq: first.sequence,
    lastEventSeq: last.sequence,
    firstEventAt: first.occurredAt,
    lastEventAt: last.occurredAt,
    eventCount: evts.length,
  };
}
