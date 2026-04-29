import { describe, expect, mock, test } from "bun:test";
import { applyReload } from "@config/applyReload";
import { WatchSchema, type WatchConfig } from "@domain/schemas/WatchesConfig";

const baseWatch = (overrides: Partial<WatchConfig> = {}): WatchConfig =>
  WatchSchema.parse({
    id: "btc-1h",
    enabled: true,
    asset: { symbol: "BTCUSDT", source: "binance" },
    timeframes: { primary: "1h", higher: [] },
    schedule: { timezone: "UTC" },
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
    setup_lifecycle: {
      ttl_candles: 50, score_initial: 25,
      score_threshold_finalizer: 80, score_threshold_dead: 10,
      invalidation_policy: "strict",
    },
    analyzers: {
      detector: { provider: "claude_max", model: "claude-sonnet-4-6" },
      reviewer: { provider: "claude_max", model: "claude-haiku-4-5" },
      finalizer: { provider: "claude_max", model: "claude-opus-4-7" },
    },
    notify_on: ["confirmed"],
    ...overrides,
  });

describe("applyReload", () => {
  test("signals reloadConfig when only non-cron fields change", async () => {
    const signal = mock(async () => undefined);
    const update = mock(async () => undefined);
    const fakeClient = {
      workflow: { getHandle: () => ({ signal }) },
      schedule: { getHandle: () => ({ update }) },
    } as unknown as Parameters<typeof applyReload>[0]["client"];

    const old = baseWatch();
    const next = baseWatch({
      setup_lifecycle: {
        ttl_candles: 50, score_initial: 25,
        score_threshold_finalizer: 75, score_threshold_dead: 10,
        invalidation_policy: "strict",
      } as WatchConfig["setup_lifecycle"],
    });

    await applyReload({ client: fakeClient, watch: next, previous: old });

    expect(signal).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  test("updates the schedule when detector_cron changes", async () => {
    const signal = mock(async () => undefined);
    const update = mock(async () => undefined);
    const fakeClient = {
      workflow: { getHandle: () => ({ signal }) },
      schedule: { getHandle: () => ({ update }) },
    } as unknown as Parameters<typeof applyReload>[0]["client"];

    const old = baseWatch();
    const next = baseWatch({ schedule: { detector_cron: "*/30 * * * *", timezone: "UTC" } });

    await applyReload({ client: fakeClient, watch: next, previous: old });

    expect(update).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledTimes(1);
  });

  test("does not update schedule when previous is null (first reload)", async () => {
    const signal = mock(async () => undefined);
    const update = mock(async () => undefined);
    const fakeClient = {
      workflow: { getHandle: () => ({ signal }) },
      schedule: { getHandle: () => ({ update }) },
    } as unknown as Parameters<typeof applyReload>[0]["client"];

    await applyReload({ client: fakeClient, watch: baseWatch(), previous: null });

    expect(signal).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
