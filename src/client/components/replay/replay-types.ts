/**
 * Client-side mirrors of the backend types served by /api/replay/*.
 * Kept manually in sync with src/domain/replay/* and src/client/api/replay.ts.
 * If divergence becomes a maintenance burden, generate from a shared schema
 * — but for v1 the duplication is small and explicit.
 */

import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";
import type { EventPayload } from "@domain/events/schemas";

export type { IndicatorSeriesContribution };

export type ReplaySessionStatus = "READY" | "PAUSED" | "COMPLETED" | "COST_CAPPED" | "FAILED";

export type LessonsMode = "current" | "historical" | "disabled";
export type FeedbackMode = "run" | "skip";

export type ReplaySessionRow = {
  id: string;
  watchId: string;
  name: string | null;
  status: ReplaySessionStatus;
  windowStartAt: string; // ISO
  windowEndAt: string;
  workflowId: string;
  configSnapshot: Record<string, unknown>;
  lessonsMode: LessonsMode;
  feedbackMode: FeedbackMode;
  costCapUsd: number;
  costUsdSoFar: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReplayEventRow = {
  id: string;
  sessionId: string;
  setupId: string | null;
  sequence: number;
  occurredAt: string;
  stage: string;
  actor: string;
  type: string;
  scoreDelta: number;
  scoreAfter: number | null;
  statusBefore: string | null;
  statusAfter: string | null;
  payload: EventPayload;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  inputHash: string | null;
  latencyMs: number | null;
  cacheHit: boolean;
};

export type SetupProjectionRow = {
  setupId: string;
  status: string;
  direction: "LONG" | "SHORT" | null;
  patternHint: string | null;
  currentScore: number;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number[] | null;
  invalidationLevel: number | null;
  closedAt: string | null;
  outcome: string | null;
  rMultiple: number | null;
  pnlPct: number | null;
  firstEventSeq: number;
  lastEventSeq: number;
  firstEventAt: string;
  lastEventAt: string;
  eventCount: number;
};

export type OhlcvCandle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type OhlcvResponse = {
  symbol: string;
  source: string;
  timeframe: string;
  from: string;
  to: string;
  windowStartAt: string;
  windowEndAt: string;
  candles: OhlcvCandle[];
  /**
   * Per-plugin indicator series computed by the backend on the same candle
   * range. Empty when the watch has no indicators enabled. The plotter
   * dispatches on `kind` (lines / priceLines / markers / histogram /
   * compound) — see `applyIndicatorToChart`.
   */
  indicators?: Record<string, IndicatorSeriesContribution>;
  /**
   * Per-plugin pane hint — `"price_overlay"` puts the contribution on the
   * main candle pane (EMA, Bollinger, structure levels), `"secondary"`
   * stacks it in its own pane below (RSI, MACD, ATR).
   */
  indicatorMeta?: Record<string, { pane: "price_overlay" | "secondary" }>;
};

export type CostByStageRow = {
  stage: string;
  totalCostUsd: number;
  calls: number;
  cacheHits: number;
};

export type CostBreakdownResponse = {
  sessionId: string;
  costUsdSoFar: number;
  costCapUsd: number;
  byStage: CostByStageRow[];
};

export type CreateSessionBody = {
  watchId: string;
  name?: string | null;
  windowStartAt: string;
  windowEndAt: string;
  costCapUsd?: number;
  lessonsMode?: LessonsMode;
  feedbackMode?: FeedbackMode;
};

/**
 * Live snapshot of the running Temporal workflow — what the UI uses to
 * decide whether a Step is safe to dispatch and to render the "raisonnement
 * en cours" indicator. `live === null` means no workflow exists yet
 * (no step has ever been sent on this session) or it has terminated normally.
 *
 * Mirrors the shape returned by `getReplayStateQuery` in
 * `src/workflows/replay/replaySessionWorkflow.ts`.
 */
export type ReplayWorkflowLiveState = {
  status: ReplaySessionStatus;
  lastTickAt: string | null;
  aliveSetups: Array<{
    id: string;
    status: string;
    score: number;
    invalidationLevel: number;
    direction: "LONG" | "SHORT";
    patternHint: string | null;
  }>;
  costUsdSoFar: number;
  /** Workflow is currently inside `processTick` (LLM activities running). */
  tickInProgress: boolean;
  /** Queue depth — ticks signaled but not yet drained. */
  pendingTicks: number;
};

export type WorkflowStateResponse = { live: ReplayWorkflowLiveState | null };
