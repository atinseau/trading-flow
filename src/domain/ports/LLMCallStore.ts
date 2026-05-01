/**
 * Per-call ledger of LLM invocations. Captures every call (detector ticks
 * with no setup, reviewer/finalizer/feedback on a setup) so cost dashboards
 * can break down by watch / provider / model / day independently of the
 * setup-scoped `events` table.
 */
export type LLMCall = {
  watchId: string | null;
  setupId: string | null;
  /** Logical pipeline stage: "detector", "reviewer", "finalizer", "feedback_*". */
  stage: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  costUsd: number;
  latencyMs?: number;
  occurredAt?: Date;
};

export interface LLMCallStore {
  record(call: LLMCall): Promise<void>;
}
