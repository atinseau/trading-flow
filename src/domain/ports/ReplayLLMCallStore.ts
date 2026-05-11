export type NewReplayLLMCall = {
  sessionId: string;
  setupId: string | null;
  stage: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  latencyMs?: number | null;
  cacheHit: boolean;
};

export type CostByStage = {
  stage: string;
  totalCostUsd: number;
  calls: number;
  cacheHits: number;
};

export interface ReplayLLMCallStore {
  record(call: NewReplayLLMCall): Promise<void>;
  costBreakdown(sessionId: string): Promise<CostByStage[]>;
}
