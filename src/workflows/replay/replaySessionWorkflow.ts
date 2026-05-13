import { isUnrecoverableErrorName, UNRECOVERABLE_ERROR_NAMES } from "@domain/errors";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  uuid4,
} from "@temporalio/workflow";
import type * as replayActivities from "./activities";
import { type AliveSetup, processTick } from "./processTick";

/**
 * Long-running Temporal workflow for a replay session.
 *
 * One workflow instance per `replay_sessions` row. Stays alive idle,
 * waking on user-driven signals from the API:
 *
 *  - `replayTickSignal({ tickAt })` — advance the playhead by one candle.
 *  - `pauseSignal` / `resumeSignal` — gate further tick processing.
 *  - `terminateSignal` — clean exit + status update.
 *
 * The golden rule (spec §1): NOTHING is automatic. The workflow only acts
 * when the user clicks "Step" (which triggers `replayTickSignal` via the
 * API). No timers, no auto-advance.
 *
 * v1 scope (J2): Detector → Reviewer → Finalizer pipeline. Setups can
 * reach CONFIRMED or REJECTED but trade lifecycle (EntryFilled/TPHit/SLHit)
 * and feedback-on-close are deferred to v2 — they need intra-candle
 * simulation which is its own subsystem.
 */

// --- Signal / query schemas --------------------------------------------------

export type ReplaySessionWorkflowArgs = {
  sessionId: string;
};

export type ReplayTickSignalArgs = {
  /** One or more ISO candle-close timestamps to enqueue, in order. The
   * `tickAts` array form lets the API batch a "Step N" click into a
   * single signal — avoiding N round-trips and N worker wake-ups. The
   * legacy `tickAt` (singular) form is kept for backward compat and is
   * normalized internally. */
  tickAt?: string;
  tickAts?: string[];
};

export const replayTickSignal = defineSignal<[ReplayTickSignalArgs]>("replayTick");
export const pauseSignal = defineSignal<[]>("pause");
export const resumeSignal = defineSignal<[]>("resume");
export const terminateSignal = defineSignal<[{ reason?: string }]>("terminate");

export type AliveSetupView = {
  id: string;
  status: SetupStatus;
  score: number;
  invalidationLevel: number;
  direction: "LONG" | "SHORT";
  patternHint: string | null;
};

export type ReplayWorkflowState = {
  /** Current session status as far as the workflow knows. */
  status: "READY" | "PAUSED" | "COMPLETED" | "COST_CAPPED" | "FAILED";
  /** ISO of the last processed tick (null until first tick succeeds). */
  lastTickAt: string | null;
  /** Snapshot of currently-alive setups. */
  aliveSetups: AliveSetupView[];
  /** Cumulative cost as seen by the workflow (sessionsRepo is source of truth). */
  costUsdSoFar: number;
  /** True iff a tick is currently in flight. */
  tickInProgress: boolean;
  /** Queue depth — useful for UI debugging. */
  pendingTicks: number;
};

export const getReplayStateQuery = defineQuery<ReplayWorkflowState>("getReplayState");

// --- Activity proxies --------------------------------------------------------
// Timeouts + retry policies aligned on the project standard (see
// `setupWorkflow` / `schedulerWorkflow`) so a contributor jumping between
// workflows finds the same numbers.

const llmActivities = proxyActivities<
  ReturnType<typeof replayActivities.buildReplayActivities>
>({
  startToCloseTimeout: "120s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    maximumInterval: "60s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [...UNRECOVERABLE_ERROR_NAMES],
  },
});

const dbActivities = proxyActivities<
  ReturnType<typeof replayActivities.buildReplayActivities>
>({
  startToCloseTimeout: "10s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "100ms",
    maximumInterval: "5s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [...UNRECOVERABLE_ERROR_NAMES],
  },
});

// --- Workflow body -----------------------------------------------------------

export async function replaySessionWorkflow(args: ReplaySessionWorkflowArgs): Promise<void> {
  // Load the session once at start. Config snapshot is immutable for the
  // session's lifetime (spec §10 invariant 5), so we trust the cached copy.
  const { session } = await dbActivities.loadReplaySession({ sessionId: args.sessionId });
  const watch = session.configSnapshot;

  const queue: string[] = [];
  let paused = session.status === "PAUSED";
  let terminated = false;
  let tickInProgress = false;
  let lastTickAt: string | null = null;
  let costUsdSoFar = session.costUsdSoFar;
  let status: ReplayWorkflowState["status"] =
    session.status === "READY" ||
    session.status === "PAUSED" ||
    session.status === "COMPLETED" ||
    session.status === "COST_CAPPED" ||
    session.status === "FAILED"
      ? session.status
      : "READY";
  const alive = new Map<string, AliveSetup>();

  /**
   * Fire-and-forget emission of a session-level `ReplayMeta` event. Used
   * from signal handlers (which can't await) and from the main loop on
   * cost-cap / failure transitions, so the UI's event log surfaces
   * paused / resumed / cost_capped / failed milestones.
   */
  function emitReplayMeta(
    kind: "paused" | "resumed" | "cost_capped" | "failed" | "reset",
    reason?: string,
  ): void {
    void dbActivities
      .appendReplayEvent({
        sessionId: args.sessionId,
        event: {
          setupId: null,
          occurredAt: new Date(),
          stage: "replay-meta",
          actor: "replay-workflow",
          type: "ReplayMeta",
          scoreDelta: 0,
          payload: { type: "ReplayMeta", data: { kind, reason } },
        },
      })
      .catch(() => undefined);
  }

  // ----- signal/query handlers must be registered before any await. -----

  setHandler(replayTickSignal, (a) => {
    if (terminated || status === "COMPLETED" || status === "FAILED") return;
    const incoming = a.tickAts ?? (a.tickAt ? [a.tickAt] : []);
    // Inv 4 (spec §10) : the workflow itself MUST refuse playheads
    // outside the session window. The API already validates incoming
    // bodies, but signals can arrive from anywhere (tests, mis-typed
    // calls, future programmatic callers). A `tickAt` outside the
    // window would consume LLM budget before the post-tick guard
    // catches it ; cheaper to drop here.
    const startMs = session.windowStartAt.getTime();
    const endMs = session.windowEndAt.getTime();
    for (const t of incoming) {
      const tMs = new Date(t).getTime();
      if (Number.isNaN(tMs)) continue;
      if (tMs < startMs || tMs > endMs) continue;
      queue.push(t);
    }
  });
  setHandler(pauseSignal, () => {
    if (status !== "READY") return;
    paused = true;
    status = "PAUSED";
    emitReplayMeta("paused", "user_pause");
  });
  setHandler(resumeSignal, () => {
    if (status !== "PAUSED") return;
    paused = false;
    status = "READY";
    emitReplayMeta("resumed", "user_resume");
  });
  setHandler(terminateSignal, (a) => {
    terminated = true;
    if (status === "READY" || status === "PAUSED") {
      status = "FAILED";
      emitReplayMeta("failed", a.reason ?? "user_terminated");
      // Fire-and-forget the persist; workflow exits in the main loop on
      // next condition check.
      void dbActivities
        .updateReplaySessionStatus({
          sessionId: args.sessionId,
          status: "FAILED",
          failureReason: a.reason ?? "user_terminated",
        })
        .catch(() => undefined);
    }
  });
  setHandler(getReplayStateQuery, () => ({
    status,
    lastTickAt,
    aliveSetups: [...alive.values()].map((s) => ({
      id: s.id,
      status: s.runtime.status,
      score: s.runtime.score,
      invalidationLevel: s.runtime.invalidationLevel,
      direction: s.runtime.direction,
      patternHint: s.snapshot.patternHint,
    })),
    costUsdSoFar,
    tickInProgress,
    pendingTicks: queue.length,
  }));

  // ----- main loop: drain the tick queue, respecting pause/terminate ----

  while (!terminated && status !== "COMPLETED" && status !== "FAILED") {
    await condition(() => terminated || (queue.length > 0 && !paused && status !== "COST_CAPPED"));
    if (terminated) break;
    const next = queue.shift();
    if (!next) continue;
    const tickAt = next;
    tickInProgress = true;
    try {
      const { costUsd: cost } = await processTick(
        { llm: llmActivities, db: dbActivities },
        {
          sessionId: args.sessionId,
          watch,
          tickAt,
          alive,
          prevTickAt: lastTickAt,
          costSoFarBefore: costUsdSoFar,
          costCapUsd: session.costCapUsd,
          newUuid: uuid4,
        },
      );
      costUsdSoFar += cost;
      lastTickAt = tickAt;

      // Cost-cap guard: pause processing if the user has burned through
      // their budget. Resumes only after the user raises the cap and
      // restarts the workflow (sessionsRepo.incrementCost is already
      // honored by the activities themselves).
      if (costUsdSoFar >= session.costCapUsd) {
        status = "COST_CAPPED";
        emitReplayMeta(
          "cost_capped",
          `cumulative cost $${costUsdSoFar.toFixed(2)} >= cap $${session.costCapUsd.toFixed(2)}`,
        );
        await dbActivities.updateReplaySessionStatus({
          sessionId: args.sessionId,
          status: "COST_CAPPED",
        });
      }

      // Completion guard: if we've reached the window end, finalize.
      if (new Date(tickAt) >= session.windowEndAt) {
        status = "COMPLETED";
        await dbActivities.updateReplaySessionStatus({
          sessionId: args.sessionId,
          status: "COMPLETED",
        });
      }
    } catch (err) {
      const reason = (err as Error).message ?? "unknown";
      // Distinguish unrecoverable domain errors from transient activity
      // failures that have only EXHAUSTED their Temporal retries. The
      // former (bad config, schema mismatch, no provider) belong in
      // FAILED — the session can't make progress without user
      // intervention. The latter shouldn't kill the session : pause it
      // so the user can re-Step after the underlying issue clears
      // (network, rate limit, market data outage).
      if (isUnrecoverableError(err)) {
        status = "FAILED";
        emitReplayMeta("failed", reason);
        await dbActivities.updateReplaySessionStatus({
          sessionId: args.sessionId,
          status: "FAILED",
          failureReason: reason,
        });
        break;
      }
      // Recoverable : pause + remember reason for the UI.
      paused = true;
      status = "PAUSED";
      emitReplayMeta("paused", `transient: ${reason}`);
      await dbActivities.updateReplaySessionStatus({
        sessionId: args.sessionId,
        status: "PAUSED",
        failureReason: `transient: ${reason}`,
      });
      // Stay in the main loop ; resumeSignal will re-arm processing.
    } finally {
      tickInProgress = false;
    }
  }
}

/**
 * Classifier for the workflow's main-loop catch. Delegates to the
 * project-wide `isUnrecoverableErrorName` so the retry policy
 * (`UNRECOVERABLE_ERROR_NAMES` on the proxies above) and the
 * catch classification stay in lockstep.
 *
 * Temporal wraps activity errors with `ApplicationFailure.type` mirroring
 * the original error.name when the activity threw a class instance —
 * `.name` is therefore reliable across both wrappers.
 */
function isUnrecoverableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return isUnrecoverableErrorName(err.name);
}

export const replaySessionWorkflowId = (sessionId: string) => `replay-session-${sessionId}`;
