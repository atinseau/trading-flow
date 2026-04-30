import type { Setup } from "@domain/entities/Setup";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type AliveSetupSummary = {
  id: string;
  workflowId: string;
  asset: string;
  timeframe: string;
  status: SetupStatus;
  currentScore: number;
  invalidationLevel: number | null;
  direction: "LONG" | "SHORT" | null;
  patternHint: string | null;
  ageInCandles: number;
};

export interface SetupRepository {
  create(setup: Omit<Setup, "createdAt" | "updatedAt" | "closedAt">): Promise<Setup>;
  get(id: string): Promise<Setup | null>;
  listAlive(watchId: string): Promise<AliveSetupSummary[]>;
  listAliveBySymbol(symbol: string, source: string): Promise<AliveSetupSummary[]>;
  markClosed(id: string, finalStatus: SetupStatus): Promise<void>;
}
