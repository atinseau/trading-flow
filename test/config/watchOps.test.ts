import { describe, expect, mock, test } from "bun:test";
import { forceTick, killSetup, pauseWatch, resumeWatch } from "@config/watchOps";

const fake = () => {
  const signal = mock(async () => undefined);
  const trigger = mock(async () => undefined);
  const pause = mock(async () => undefined);
  const unpause = mock(async () => undefined);
  const client = {
    workflow: { getHandle: () => ({ signal }) },
    schedule: { getHandle: () => ({ trigger, pause, unpause }) },
  } as unknown as Parameters<typeof pauseWatch>[0]["client"];
  return { client, signal, trigger, pause, unpause };
};

describe("watchOps", () => {
  test("pauseWatch pauses the schedule", async () => {
    const { client, pause } = fake();
    await pauseWatch({ client, watchId: "btc-1h" });
    expect(pause).toHaveBeenCalledTimes(1);
  });

  test("resumeWatch unpauses the schedule", async () => {
    const { client, unpause } = fake();
    await resumeWatch({ client, watchId: "btc-1h" });
    expect(unpause).toHaveBeenCalledTimes(1);
  });

  test("forceTick triggers the schedule immediately", async () => {
    const { client, trigger } = fake();
    await forceTick({ client, watchId: "btc-1h" });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  test("killSetup signals the SetupWorkflow", async () => {
    const { client, signal } = fake();
    await killSetup({ client, setupId: "abc-123", reason: "manual" });
    expect(signal).toHaveBeenCalledTimes(1);
    const calls = signal.mock.calls as unknown as [string, { reason: string }][];
    expect(calls[0]?.[0]).toBe("close");
  });
});
