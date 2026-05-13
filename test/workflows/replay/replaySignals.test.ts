import { describe, expect, test } from "bun:test";
import { TemporalReplaySignalSender } from "@workflows/replay/replaySignals";

/**
 * Mock the bits of `@temporalio/client` that `TemporalReplaySignalSender`
 * touches : `client.workflow.signalWithStart` and
 * `client.workflow.getHandle(id).signal()`. Keeps the test hermetic — no
 * real Temporal connection.
 */
function makeFakeClient() {
  const signalWithStartCalls: Array<{
    workflowId: string;
    taskQueue: string;
    args: unknown[];
    signal: unknown;
    signalArgs: unknown[];
  }> = [];
  const handleSignalCalls: Array<{ workflowId: string; signal: unknown; args: unknown[] }> = [];

  const client = {
    workflow: {
      signalWithStart: async (
        _workflowFn: unknown,
        opts: {
          workflowId: string;
          taskQueue: string;
          args: unknown[];
          signal: unknown;
          signalArgs: unknown[];
        },
      ) => {
        signalWithStartCalls.push(opts);
      },
      getHandle: (workflowId: string) => ({
        signal: async (signal: unknown, ...args: unknown[]) => {
          handleSignalCalls.push({ workflowId, signal, args });
        },
      }),
    },
  } as unknown as import("@temporalio/client").Client;

  return { client, signalWithStartCalls, handleSignalCalls };
}

describe("TemporalReplaySignalSender", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";

  test("step single-tick uses signalWithStart with the correct workflowId + taskQueue", async () => {
    const fake = makeFakeClient();
    const sender = new TemporalReplaySignalSender(fake.client, "test-replay-queue");
    await sender.step({ sessionId, tickAt: "2026-04-12T15:00:00.000Z" });
    expect(fake.signalWithStartCalls).toHaveLength(1);
    expect(fake.signalWithStartCalls[0]?.workflowId).toBe(`replay-session-${sessionId}`);
    expect(fake.signalWithStartCalls[0]?.taskQueue).toBe("test-replay-queue");
    expect(fake.signalWithStartCalls[0]?.signalArgs).toEqual([
      { tickAt: "2026-04-12T15:00:00.000Z", tickAts: undefined },
    ]);
  });

  test("step with tickAts (batch) forwards the array on signalArgs", async () => {
    const fake = makeFakeClient();
    const sender = new TemporalReplaySignalSender(fake.client, "test-replay-queue");
    const batch = [
      "2026-04-12T15:00:00.000Z",
      "2026-04-12T16:00:00.000Z",
      "2026-04-12T17:00:00.000Z",
    ];
    await sender.step({ sessionId, tickAts: batch });
    expect(fake.signalWithStartCalls).toHaveLength(1);
    expect(fake.signalWithStartCalls[0]?.signalArgs).toEqual([
      { tickAt: undefined, tickAts: batch },
    ]);
  });

  test("pause/resume/terminate use the existing-handle signal path (no start)", async () => {
    const fake = makeFakeClient();
    const sender = new TemporalReplaySignalSender(fake.client, "q");
    await sender.pause({ sessionId });
    await sender.resume({ sessionId });
    await sender.terminate({ sessionId, reason: "user_abort" });
    expect(fake.signalWithStartCalls).toHaveLength(0);
    expect(fake.handleSignalCalls).toHaveLength(3);
    expect(fake.handleSignalCalls.every((c) => c.workflowId === `replay-session-${sessionId}`)).toBe(
      true,
    );
  });

  test("step repeated with same sessionId always targets the same deterministic workflowId", async () => {
    const fake = makeFakeClient();
    const sender = new TemporalReplaySignalSender(fake.client, "q");
    await sender.step({ sessionId, tickAt: "2026-04-12T15:00:00.000Z" });
    await sender.step({ sessionId, tickAt: "2026-04-12T16:00:00.000Z" });
    expect(fake.signalWithStartCalls).toHaveLength(2);
    expect(fake.signalWithStartCalls[0]?.workflowId).toBe(fake.signalWithStartCalls[1]?.workflowId);
  });
});
