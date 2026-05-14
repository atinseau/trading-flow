import type { CapturedEvent } from "./types";

/**
 * Canonical-event comparator for cross-pipeline parity assertions.
 *
 * Both pipelines persist some events that have no counterpart in the
 * other (by design, not by drift) — those are filtered out before
 * comparison :
 *
 *   - Replay emits `FeedbackLessonProposed` (proposals only, no live
 *     write), `DetectorTickProcessed` (per-tick bookkeeping), `ReplayMeta`
 *     (session-level annotations), and `EntryFilled` (the replay
 *     intra-candle tracker reports the limit fill ; the live tracker
 *     gets prices via signal and skips straight to TP/SL checks
 *     without emitting an EntryFilled marker).
 *   - Live emits `Killed` (no kill button in replay UI) and
 *     `SetupCreated` (the parity scenarios seed an alive setup into
 *     replay's `alive` map directly ; live's setupWorkflow always
 *     emits SetupCreated at startup. Both pipelines DO emit
 *     SetupCreated on the detector new_setups path — that path is
 *     not yet exercised by parity scenarios).
 *
 * What's left is the "canonical" chain — the events both pipelines must
 * produce identically. Drifts are returned as a list, not thrown, so
 * tests can include the whole drift report in their failure message.
 */

const REPLAY_ONLY_TYPES: ReadonlySet<string> = new Set([
  "DetectorTickProcessed",
  "ReplayMeta",
  "FeedbackLessonProposed",
  "EntryFilled",
]);

const LIVE_ONLY_TYPES: ReadonlySet<string> = new Set(["Killed", "SetupCreated"]);

export type DriftField =
  | "length"
  | "type"
  | "statusBefore"
  | "statusAfter"
  | "scoreDeltaSign"
  | "payloadSource";

export type Drift = {
  index: number;
  field: DriftField;
  live: unknown;
  replay: unknown;
  message: string;
};

function sign(n: number): -1 | 0 | 1 {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

export function compareCanonical(live: CapturedEvent[], replay: CapturedEvent[]): Drift[] {
  const liveCanonical = live.filter((e) => !LIVE_ONLY_TYPES.has(e.type));
  const replayCanonical = replay.filter((e) => !REPLAY_ONLY_TYPES.has(e.type));
  const drifts: Drift[] = [];

  if (liveCanonical.length !== replayCanonical.length) {
    drifts.push({
      index: -1,
      field: "length",
      live: liveCanonical.length,
      replay: replayCanonical.length,
      message: `live emitted ${liveCanonical.length} canonical events, replay emitted ${replayCanonical.length}`,
    });
    // Per-index drilldown only makes sense when the lengths agree —
    // otherwise we'd report a long list of off-by-one type mismatches.
    return drifts;
  }

  for (let i = 0; i < liveCanonical.length; i++) {
    const l = liveCanonical[i];
    const r = replayCanonical[i];
    if (!l || !r) continue;

    if (l.type !== r.type) {
      drifts.push({
        index: i,
        field: "type",
        live: l.type,
        replay: r.type,
        message: `event #${i} type mismatch (live=${l.type}, replay=${r.type})`,
      });
    }
    if (l.statusBefore !== r.statusBefore) {
      drifts.push({
        index: i,
        field: "statusBefore",
        live: l.statusBefore,
        replay: r.statusBefore,
        message: `event #${i} statusBefore mismatch (live=${l.statusBefore}, replay=${r.statusBefore})`,
      });
    }
    if (l.statusAfter !== r.statusAfter) {
      drifts.push({
        index: i,
        field: "statusAfter",
        live: l.statusAfter,
        replay: r.statusAfter,
        message: `event #${i} statusAfter mismatch (live=${l.statusAfter}, replay=${r.statusAfter})`,
      });
    }
    if (sign(l.scoreDelta) !== sign(r.scoreDelta)) {
      drifts.push({
        index: i,
        field: "scoreDeltaSign",
        live: sign(l.scoreDelta),
        replay: sign(r.scoreDelta),
        message: `event #${i} scoreDelta sign mismatch (live=${l.scoreDelta}, replay=${r.scoreDelta})`,
      });
    }
    if (l.payloadSource !== r.payloadSource) {
      drifts.push({
        index: i,
        field: "payloadSource",
        live: l.payloadSource,
        replay: r.payloadSource,
        message: `event #${i} payload source mismatch (live=${l.payloadSource}, replay=${r.payloadSource})`,
      });
    }
  }

  return drifts;
}
