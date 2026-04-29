import { describe, expect, mock, test } from "bun:test";
import { tearDownWatch } from "@config/tearDownWatch";

describe("tearDownWatch", () => {
  test("deletes schedule and terminates both workflows", async () => {
    const scheduleDelete = mock(async () => undefined);
    const wfTerminate = mock(async () => undefined);
    const fakeClient = {
      workflow: { getHandle: () => ({ terminate: wfTerminate }) },
      schedule: { getHandle: () => ({ delete: scheduleDelete }) },
    } as unknown as Parameters<typeof tearDownWatch>[0]["client"];

    await tearDownWatch({ client: fakeClient, watchId: "btc-1h" });

    expect(scheduleDelete).toHaveBeenCalledTimes(1);
    expect(wfTerminate).toHaveBeenCalledTimes(2);
  });

  test("is idempotent — already-deleted entities tolerated", async () => {
    const fakeClient = {
      workflow: {
        getHandle: () => ({
          terminate: mock(async () => { throw new Error("Workflow not found"); }),
        }),
      },
      schedule: {
        getHandle: () => ({
          delete: mock(async () => { throw new Error("schedule not found"); }),
        }),
      },
    } as unknown as Parameters<typeof tearDownWatch>[0]["client"];

    await expect(tearDownWatch({ client: fakeClient, watchId: "ghost" })).resolves.toBeUndefined();
  });

  test("propagates non-not-found errors", async () => {
    const fakeClient = {
      workflow: { getHandle: () => ({ terminate: mock(async () => undefined) }) },
      schedule: {
        getHandle: () => ({
          delete: mock(async () => { throw new Error("postgres connection refused"); }),
        }),
      },
    } as unknown as Parameters<typeof tearDownWatch>[0]["client"];

    await expect(tearDownWatch({ client: fakeClient, watchId: "x" })).rejects.toThrow(/postgres/);
  });
});
