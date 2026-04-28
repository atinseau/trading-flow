import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type Setup = {
  id: string;
  watchId: string;
  asset: string;
  timeframe: string;
  status: SetupStatus;
  currentScore: number;
  patternHint: string | null;
  invalidationLevel: number | null;
  direction: "LONG" | "SHORT" | null;
  ttlCandles: number;
  ttlExpiresAt: Date;
  workflowId: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};
