import type { WatchConfig } from "@domain/schemas/WatchesConfig";

/**
 * Lifecycle of a replay session.
 *
 * - `READY` — workflow exists and is idle ; ready to receive `replayTickSignal`.
 * - `PAUSED` — user paused ; tick signals are ignored until `resume`.
 * - `COMPLETED` — playhead reached `windowEndAt`. Workflow terminated.
 * - `COST_CAPPED` — cumulative LLM cost reached `costCapUsd`. Reprenable
 *   after the user raises the cap.
 * - `FAILED` — unrecoverable error during a step ; `failureReason` is set.
 */
export type ReplaySessionStatus = "READY" | "PAUSED" | "COMPLETED" | "COST_CAPPED" | "FAILED";

/** Modes for injecting lessons into the replay's pipeline prompts. */
export type LessonsMode = "current" | "historical" | "disabled";

/** Modes for running (or not) the feedback loop on trade close. */
export type FeedbackMode = "run" | "skip";

/** Persisted replay session row. */
export type ReplaySession = {
  id: string;
  watchId: string;
  name: string | null;
  status: ReplaySessionStatus;
  windowStartAt: Date;
  windowEndAt: Date;
  /** Deterministic Temporal workflow ID (see `buildWorkflowId`). */
  workflowId: string;
  /**
   * Snapshot of the watch's config at creation time. Immutable for the
   * lifetime of the session — guarantees reproducibility even if the watch
   * is later edited.
   */
  configSnapshot: WatchConfig;
  lessonsMode: LessonsMode;
  feedbackMode: FeedbackMode;
  costCapUsd: number;
  /** Cumulative LLM cost for this session in USD. Updated by activities. */
  costUsdSoFar: number;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Input for creating a new session (caller-supplied fields only). */
export type NewReplaySession = Omit<
  ReplaySession,
  "id" | "status" | "costUsdSoFar" | "failureReason" | "createdAt" | "updatedAt"
> & {
  /** Optional override at create-time ; defaults to a fresh UUID v4 server-side. */
  id?: string;
};
