import { proxyActivities } from "@temporalio/workflow";
import type { CloseOutcome } from "../../domain/feedback/closeOutcome";
import type * as activities from "./activities";

const SHARED_NON_RETRYABLE = [
  "InvalidConfigError",
  "AssetNotFoundError",
  "LLMSchemaValidationError",
  "PromptTooLargeError",
  "NoProviderAvailableError",
  "CircularFallbackError",
  "StopRequestedError",
];

// Context activity — moderate timeout, few retries (mostly DB + artifact I/O).
const contextActivity = proxyActivities<ReturnType<typeof activities.buildFeedbackActivities>>({
  startToCloseTimeout: "60s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "500ms",
    maximumInterval: "10s",
    backoffCoefficient: 2,
  },
});

// LLM activity — long timeout, careful retries with non-retryable schema/config errors.
const llmActivities = proxyActivities<ReturnType<typeof activities.buildFeedbackActivities>>({
  startToCloseTimeout: "180s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    maximumInterval: "60s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

// DB / persistence activity — many fast retries (transient blips).
const dbActivities = proxyActivities<ReturnType<typeof activities.buildFeedbackActivities>>({
  startToCloseTimeout: "15s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "100ms",
    maximumInterval: "5s",
    backoffCoefficient: 2,
  },
});

export type FeedbackLoopArgs = {
  setupId: string;
  watchId: string;
  closeOutcome: CloseOutcome;
  scoreAtClose: number;
};

export type FeedbackLoopResult = {
  changesApplied: number;
  pendingApprovalsCreated: number;
  costUsd: number;
};

/**
 * Three-stage feedback pipeline:
 *   1. gather context (artifact + chunk hashes)
 *   2. run LLM analysis (with idempotence cache by inputHash)
 *   3. apply lesson changes (if not cached)
 *
 * On cache hit (`analysis.cached === true`) the workflow short-circuits and
 * returns zeros without invoking `applyLessonChanges` — see the doc comment on
 * `RunFeedbackAnalysisResult.cached` in `activities.ts` for rationale.
 */
export async function feedbackLoopWorkflow(args: FeedbackLoopArgs): Promise<FeedbackLoopResult> {
  const ctx = await contextActivity.gatherFeedbackContext({
    setupId: args.setupId,
    watchId: args.watchId,
    closeOutcome: args.closeOutcome,
  });

  const analysis = await llmActivities.runFeedbackAnalysis({
    setupId: args.setupId,
    watchId: args.watchId,
    contextRef: ctx.contextRef,
    chunkHashes: ctx.chunkHashes,
  });

  if (analysis.cached) {
    // Prior run with same inputHash already persisted its events; skipping
    // applyLessonChanges keeps observability clean (no misleading "0 changes
    // applied" log line for a cache hit).
    return { changesApplied: 0, pendingApprovalsCreated: 0, costUsd: 0 };
  }

  const result = await dbActivities.applyLessonChanges({
    setupId: args.setupId,
    watchId: args.watchId,
    closeReason: args.closeOutcome.reason,
    proposedActions: analysis.actions,
    feedbackPromptVersion: analysis.promptVersion,
    provider: analysis.provider,
    model: analysis.model,
    inputHash: analysis.inputHash,
    costUsd: analysis.costUsd,
    latencyMs: analysis.latencyMs,
  });

  return result;
}

export const feedbackWorkflowId = (setupId: string) => `feedback-${setupId}`;
