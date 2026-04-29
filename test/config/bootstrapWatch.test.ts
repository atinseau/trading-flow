import { describe, expect, mock, test } from "bun:test";
import { bootstrapWatch, type TaskQueues } from "@config/bootstrapWatch";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { WatchSchema } from "@domain/schemas/WatchesConfig";

const watch: WatchConfig = WatchSchema.parse({
  id: "btc-1h",
  enabled: true,
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: [] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50,
    score_initial: 25,
    score_threshold_finalizer: 80,
    score_threshold_dead: 10,
    invalidation_policy: "strict",
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6" },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5" },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7" },
    feedback: { provider: "claude_max", model: "claude-opus-4-7" },
  },
  notify_on: ["confirmed"],
});

const taskQueues: TaskQueues = {
  scheduler: "scheduler",
  analysis: "analysis",
  notifications: "notifications",
};

class FakeScheduleNotFound extends Error {
  constructor() {
    super("schedule not found");
    this.name = "ScheduleNotFoundError";
  }
}

describe("bootstrapWatch", () => {
  test("starts both workflows and creates the schedule when none exists", async () => {
    const startMock = mock(async () => undefined);
    const scheduleCreate = mock(async () => undefined);
    const fakeClient = {
      workflow: { start: startMock },
      schedule: {
        getHandle: () => ({
          describe: mock(async () => {
            throw new FakeScheduleNotFound();
          }),
          update: mock(async () => undefined),
        }),
        create: scheduleCreate,
      },
    } as unknown as Parameters<typeof bootstrapWatch>[1]["client"];

    await bootstrapWatch(watch, { client: fakeClient, taskQueues });

    expect(startMock.mock.calls.length).toBe(1);
    expect(scheduleCreate).toHaveBeenCalledTimes(1);
  });

  test("is idempotent — already-running workflows are tolerated", async () => {
    const startMock = mock(async () => {
      throw new Error("Workflow already started");
    });
    const fakeClient = {
      workflow: { start: startMock },
      schedule: {
        getHandle: () => ({
          describe: mock(async () => ({ spec: {} })),
          update: mock(async () => undefined),
        }),
        create: mock(async () => undefined),
      },
    } as unknown as Parameters<typeof bootstrapWatch>[1]["client"];

    await expect(
      bootstrapWatch(watch, { client: fakeClient, taskQueues }),
    ).resolves.toBeUndefined();
  });

  test("uses cronForTimeframe when detector_cron is absent", async () => {
    const scheduleCreate = mock(async () => undefined);
    const fakeClient = {
      workflow: { start: mock(async () => undefined) },
      schedule: {
        getHandle: () => ({
          describe: mock(async () => {
            throw new FakeScheduleNotFound();
          }),
          update: mock(async () => undefined),
        }),
        create: scheduleCreate,
      },
    } as unknown as Parameters<typeof bootstrapWatch>[1]["client"];

    await bootstrapWatch(watch, { client: fakeClient, taskQueues });

    const calls = scheduleCreate.mock.calls as unknown as [
      { spec: { cronExpressions: string[] } },
    ][];
    const call = calls[0]![0];
    expect(call.spec.cronExpressions[0]).toBe("0 * * * *"); // 1h cron
  });
});
