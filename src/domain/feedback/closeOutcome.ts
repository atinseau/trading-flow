import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type TrackingResultReason =
  | "sl_hit_direct"
  | "sl_hit_after_tp1"
  | "price_invalidated"
  | "all_tps_hit";

export type TrackingResult = {
  reason: TrackingResultReason;
};

export type CloseReason = TrackingResultReason | "expired" | "rejected" | "never_confirmed";

export type CloseOutcome = {
  reason: CloseReason;
  everConfirmed: boolean;
};

export function deriveCloseOutcome(input: {
  finalStatus: SetupStatus;
  trackingResult?: TrackingResult;
  everConfirmed: boolean;
}): CloseOutcome {
  if (input.trackingResult) {
    return { reason: input.trackingResult.reason, everConfirmed: input.everConfirmed };
  }
  switch (input.finalStatus) {
    case "EXPIRED":
      return { reason: "expired", everConfirmed: input.everConfirmed };
    case "REJECTED":
      return { reason: "rejected", everConfirmed: input.everConfirmed };
    case "INVALIDATED":
      return {
        reason: input.everConfirmed ? "price_invalidated" : "never_confirmed",
        everConfirmed: input.everConfirmed,
      };
    default:
      return { reason: "never_confirmed", everConfirmed: input.everConfirmed };
  }
}

export function shouldTriggerFeedback(o: CloseOutcome): boolean {
  if (!o.everConfirmed) return false;
  return (
    o.reason === "sl_hit_direct" ||
    o.reason === "sl_hit_after_tp1" ||
    o.reason === "price_invalidated"
  );
}
