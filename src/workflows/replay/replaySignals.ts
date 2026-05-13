import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import {
  pauseSignal,
  replaySessionWorkflow,
  replaySessionWorkflowId,
  replayTickSignal,
  resumeSignal,
  terminateSignal,
} from "./replaySessionWorkflow";

const log = getLogger({ component: "replay-signals" });

/**
 * Abstraction over the Temporal client used by the API layer to signal
 * the replay workflow. Defined as a port so the API can be tested with
 * a fake (no Temporal connection required in unit tests).
 *
 * `step` uses `signalWithStart` so the workflow is created on the first
 * step (idempotent — replaying the same call is a no-op). All other
 * methods assume the workflow exists ; if not, the underlying error
 * surfaces.
 */
export interface ReplaySignalSender {
  /** Either `tickAt` (single candle) or `tickAts` (batch ; e.g. "Step 5"). */
  step(args: {
    sessionId: string;
    tickAt?: string;
    tickAts?: string[];
  }): Promise<void>;
  pause(args: { sessionId: string }): Promise<void>;
  resume(args: { sessionId: string }): Promise<void>;
  terminate(args: { sessionId: string; reason?: string }): Promise<void>;
}

/**
 * Production implementation backed by the Temporal client. The task
 * queue is provided at construction time so we don't tie this module to
 * a specific `InfraConfig` field path.
 */
export class TemporalReplaySignalSender implements ReplaySignalSender {
  constructor(
    private readonly client: Client,
    private readonly taskQueue: string,
  ) {}

  async step(args: {
    sessionId: string;
    tickAt?: string;
    tickAts?: string[];
  }): Promise<void> {
    await this.client.workflow.signalWithStart(replaySessionWorkflow, {
      workflowId: replaySessionWorkflowId(args.sessionId),
      taskQueue: this.taskQueue,
      args: [{ sessionId: args.sessionId }],
      signal: replayTickSignal,
      signalArgs: [{ tickAt: args.tickAt, tickAts: args.tickAts }],
    });
    log.info(
      {
        sessionId: args.sessionId,
        tickAt: args.tickAt,
        tickAtsCount: args.tickAts?.length,
      },
      "step signal sent",
    );
  }

  async pause(args: { sessionId: string }): Promise<void> {
    await this.client.workflow
      .getHandle(replaySessionWorkflowId(args.sessionId))
      .signal(pauseSignal);
    log.info({ sessionId: args.sessionId }, "pause signal sent");
  }

  async resume(args: { sessionId: string }): Promise<void> {
    await this.client.workflow
      .getHandle(replaySessionWorkflowId(args.sessionId))
      .signal(resumeSignal);
    log.info({ sessionId: args.sessionId }, "resume signal sent");
  }

  async terminate(args: { sessionId: string; reason?: string }): Promise<void> {
    await this.client.workflow
      .getHandle(replaySessionWorkflowId(args.sessionId))
      .signal(terminateSignal, { reason: args.reason });
    log.info({ sessionId: args.sessionId, reason: args.reason }, "terminate signal sent");
  }
}
