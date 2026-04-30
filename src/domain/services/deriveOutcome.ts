import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import { TERMINAL_STATUSES } from "@domain/state-machine/setupTransitions";

export type Outcome =
  | "WIN"
  | "LOSS"
  | "PARTIAL_WIN"
  | "TIME_OUT"
  | "REJECTED"
  | "INVALIDATED_PRE_TRADE"
  | "INVALIDATED_POST_TRADE"
  | "EXPIRED_NO_FILL";

export type EventTypeLite = {
  type: string;
  sequence: number;
};

/**
 * Returns null for active setups (LIVE — no outcome yet).
 * For terminal setups, derives the outcome by inspecting the event timeline.
 */
export function deriveOutcome(status: SetupStatus, events: EventTypeLite[]): Outcome | null {
  if (!TERMINAL_STATUSES.has(status)) return null;

  if (status === "REJECTED") return "REJECTED";

  const hasEvent = (t: string) => events.some((e) => e.type === t);
  const hasConfirmed = hasEvent("Confirmed");
  const hasEntryFilled = hasEvent("EntryFilled");
  const tpHits = events.filter((e) => e.type === "TPHit").length;
  const slHits = events.filter((e) => e.type === "SLHit").length;

  if (status === "INVALIDATED") {
    if (hasEntryFilled) return "INVALIDATED_POST_TRADE";
    return "INVALIDATED_PRE_TRADE";
  }

  if (status === "EXPIRED") {
    if (!hasConfirmed) return "INVALIDATED_PRE_TRADE"; // expired during refinement
    if (!hasEntryFilled) return "EXPIRED_NO_FILL";
    if (tpHits === 0 && slHits === 0) return "TIME_OUT";
    if (tpHits > 0 && slHits === 0) return "WIN";
    if (slHits > 0 && tpHits === 0) return "LOSS";
    return "PARTIAL_WIN";
  }

  // status === "CLOSED" — natural end of trade
  if (tpHits > 0 && slHits === 0) return "WIN";
  if (slHits > 0 && tpHits === 0) return "LOSS";
  if (tpHits > 0 && slHits > 0) return "PARTIAL_WIN";
  return "TIME_OUT"; // closed without any TP/SL trigger (rare, e.g. manual kill)
}
