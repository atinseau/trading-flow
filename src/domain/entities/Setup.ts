import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type Setup = {
  id: string;
  watchId: string;
  asset: string;
  timeframe: string;
  status: SetupStatus;
  currentScore: number;
  patternHint: string | null;
  /** "event" (1-tick triggers) | "accumulation" (multi-touch) — analytic label, no longer the maturation control. */
  patternCategory: "event" | "accumulation" | null;
  /**
   * Detector estimate of reviewer ticks needed to reach finalizer-ready
   * conviction. 1 = instant (event, trigger formed), 6 = slow accumulation.
   * Used by finalizer's maturation rule. Null for legacy rows.
   */
  expectedMaturationTicks: number | null;
  invalidationLevel: number | null;
  direction: "LONG" | "SHORT" | null;
  ttlCandles: number;
  ttlExpiresAt: Date;
  workflowId: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};
