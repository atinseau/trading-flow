import type { ReplaySession, ReplaySessionStatus } from "@domain/replay/ReplaySession";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";

export type NewReplaySessionInput = {
  /** Optional override; adapter assigns a fresh uuid4 when omitted. */
  id?: string;
  watchId: string;
  name: string | null;
  status: ReplaySessionStatus;
  windowStartAt: Date;
  windowEndAt: Date;
  workflowId: string;
  configSnapshot: WatchConfig;
  lessonsMode: "current" | "historical" | "disabled";
  feedbackMode: "run" | "skip";
  costCapUsd: number;
};

export type ListFilter = {
  watchId?: string;
  status?: ReplaySessionStatus;
  limit?: number;
};

export interface ReplaySessionRepository {
  create(input: NewReplaySessionInput): Promise<ReplaySession>;
  get(id: string): Promise<ReplaySession | null>;
  list(filter: ListFilter): Promise<ReplaySession[]>;
  updateStatus(id: string, status: ReplaySessionStatus, failureReason?: string): Promise<void>;
  /**
   * Atomic increment of cost_usd_so_far. Called by activities after each
   * LLM call. Two concurrent increments must sum correctly (UPDATE ... SET
   * cost = cost + delta).
   */
  incrementCost(id: string, deltaUsd: number): Promise<void>;
  delete(id: string): Promise<void>;
}
