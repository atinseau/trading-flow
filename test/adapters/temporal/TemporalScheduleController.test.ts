import { describe, expect, test } from "bun:test";
import { TemporalScheduleController } from "@adapters/temporal/TemporalScheduleController";
import { ScheduleNotFoundError } from "@temporalio/client";

function makeFakeClient(opts: {
  pauseImpl?: (id: string, reason: string) => Promise<void>;
  unpauseImpl?: (id: string) => Promise<void>;
}) {
  return {
    schedule: {
      getHandle: (id: string) => ({
        pause: (reason: string) => opts.pauseImpl?.(id, reason) ?? Promise.resolve(),
        unpause: () => opts.unpauseImpl?.(id) ?? Promise.resolve(),
      }),
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal client surface for tests
  } as any;
}

describe("TemporalScheduleController", () => {
  test("pause forwards id + reason to Temporal", async () => {
    const calls: Array<{ id: string; reason: string }> = [];
    const ctrl = new TemporalScheduleController(
      makeFakeClient({
        pauseImpl: async (id, reason) => {
          calls.push({ id, reason });
        },
      }),
    );
    await ctrl.pause("tick-watch_aapl", "market closed");
    expect(calls).toEqual([{ id: "tick-watch_aapl", reason: "market closed" }]);
  });

  test("unpause forwards id to Temporal", async () => {
    const calls: string[] = [];
    const ctrl = new TemporalScheduleController(
      makeFakeClient({
        unpauseImpl: async (id) => {
          calls.push(id);
        },
      }),
    );
    await ctrl.unpause("tick-watch_aapl");
    expect(calls).toEqual(["tick-watch_aapl"]);
  });

  test("pause swallows ScheduleNotFoundError (logs warn, no throw)", async () => {
    const ctrl = new TemporalScheduleController(
      makeFakeClient({
        pauseImpl: async () => {
          throw new ScheduleNotFoundError("missing", "tick-x");
        },
      }),
    );
    await expect(ctrl.pause("tick-x", "any")).resolves.toBeUndefined();
  });

  test("unpause swallows ScheduleNotFoundError", async () => {
    const ctrl = new TemporalScheduleController(
      makeFakeClient({
        unpauseImpl: async () => {
          throw new ScheduleNotFoundError("missing", "tick-x");
        },
      }),
    );
    await expect(ctrl.unpause("tick-x")).resolves.toBeUndefined();
  });

  test("swallows error matching by name (defensive fallback)", async () => {
    class FakeNotFound extends Error {
      constructor() {
        super("missing");
        this.name = "ScheduleNotFoundError";
      }
    }
    const ctrl = new TemporalScheduleController(
      makeFakeClient({
        pauseImpl: async () => {
          throw new FakeNotFound();
        },
      }),
    );
    await expect(ctrl.pause("tick-x", "any")).resolves.toBeUndefined();
  });

  test("re-throws unrelated errors from pause", async () => {
    const ctrl = new TemporalScheduleController(
      makeFakeClient({
        pauseImpl: async () => {
          throw new Error("network down");
        },
      }),
    );
    await expect(ctrl.pause("tick-x", "any")).rejects.toThrow("network down");
  });

  test("re-throws unrelated errors from unpause", async () => {
    const ctrl = new TemporalScheduleController(
      makeFakeClient({
        unpauseImpl: async () => {
          throw new Error("auth failed");
        },
      }),
    );
    await expect(ctrl.unpause("tick-x")).rejects.toThrow("auth failed");
  });
});
