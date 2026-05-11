import type { ReplaySignalSender } from "@workflows/replay/replaySignals";

type SignalCall =
  | { kind: "step"; sessionId: string; tickAt: string }
  | { kind: "pause"; sessionId: string }
  | { kind: "resume"; sessionId: string }
  | { kind: "terminate"; sessionId: string; reason?: string };

/**
 * Capture-only signaller for testing the replay API without a Temporal
 * connection. Records every signal call in arrival order so tests can
 * assert exact dispatch + arguments.
 */
export class FakeReplaySignalSender implements ReplaySignalSender {
  calls: SignalCall[] = [];

  async step(args: { sessionId: string; tickAt: string }): Promise<void> {
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

  reset(): void {
    this.calls = [];
  }
}
