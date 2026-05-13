import type { ReplayWorkflowState } from "@workflows/replay/replaySessionWorkflow";
import type { ReplaySignalSender } from "@workflows/replay/replaySignals";

type SignalCall =
  | { kind: "step"; sessionId: string; tickAt?: string; tickAts?: string[] }
  | { kind: "pause"; sessionId: string }
  | { kind: "resume"; sessionId: string }
  | { kind: "terminate"; sessionId: string; reason?: string }
  | { kind: "getWorkflowState"; sessionId: string };

/**
 * Capture-only signaller for testing the replay API without a Temporal
 * connection. Records every signal call in arrival order so tests can
 * assert exact dispatch + arguments.
 */
export class FakeReplaySignalSender implements ReplaySignalSender {
  calls: SignalCall[] = [];
  /** Programmable response for `getWorkflowState`. Defaults to `null`
   *  (workflow not started / terminated). */
  workflowState: ReplayWorkflowState | null = null;

  async step(args: { sessionId: string; tickAt?: string; tickAts?: string[] }): Promise<void> {
    this.calls.push({ kind: "step", ...args });
  }
  async pause(args: { sessionId: string }): Promise<void> {
    this.calls.push({ kind: "pause", ...args });
  }
  async resume(args: { sessionId: string }): Promise<void> {
    this.calls.push({ kind: "resume", ...args });
  }
  async terminate(args: { sessionId: string; reason?: string }): Promise<void> {
    this.calls.push({ kind: "terminate", ...args });
  }
  async getWorkflowState(args: { sessionId: string }): Promise<ReplayWorkflowState | null> {
    this.calls.push({ kind: "getWorkflowState", ...args });
    return this.workflowState;
  }

  reset(): void {
    this.calls = [];
    this.workflowState = null;
  }
}
