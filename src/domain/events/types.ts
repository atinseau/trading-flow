export type EventStage = "detector" | "reviewer" | "finalizer" | "tracker" | "system";

export type EventTypeName =
  | "SetupCreated"
  | "Strengthened"
  | "Weakened"
  | "Neutral"
  | "Invalidated"
  | "Confirmed"
  | "Rejected"
  | "EntryFilled"
  | "TPHit"
  | "SLHit"
  | "TrailingMoved"
  | "Expired"
  | "PriceInvalidated";
