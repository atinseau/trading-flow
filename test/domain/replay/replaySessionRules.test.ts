import { describe, expect, test } from "bun:test";
import {
  buildWorkflowId,
  type CreateSessionArgs,
  DEFAULT_COST_CAP_USD,
  MAX_WINDOW_CANDLES,
  MIN_COST_CAP_USD,
  type Timeframe,
  timeframeToMinutes,
  validateCreateSession,
} from "@domain/replay/replaySessionRules";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";

const now = new Date("2026-05-08T12:00:00.000Z");

function mkArgs(overrides: Partial<CreateSessionArgs> = {}): CreateSessionArgs {
  return {
    watchId: "btc-1h",
    watchConfig: {
      timeframes: { primary: "1h", higher: [] },
    } as unknown as WatchConfig,
    windowStartAt: new Date("2026-04-12T14:00:00.000Z"),
    windowEndAt: new Date("2026-04-13T14:00:00.000Z"), // 24h on 1h = 24 candles
    lessonsMode: "current",
    feedbackMode: "run",
    costCapUsd: DEFAULT_COST_CAP_USD,
    now,
    ...overrides,
  };
}

describe("validateCreateSession", () => {
  test("valid args → ok", () => {
    expect(validateCreateSession(mkArgs())).toEqual({ ok: true });
  });

  test("windowEnd <= windowStart → window_invalid", () => {
    const r = validateCreateSession(
      mkArgs({
        windowStartAt: new Date("2026-04-13T14:00:00.000Z"),
        windowEndAt: new Date("2026-04-12T14:00:00.000Z"),
      }),
    );
    expect(r).toEqual({ ok: false, reason: "window_invalid" });
  });

  test("windowEnd == windowStart → window_invalid", () => {
    const d = new Date("2026-04-13T14:00:00.000Z");
    const r = validateCreateSession(mkArgs({ windowStartAt: d, windowEndAt: d }));
    expect(r).toEqual({ ok: false, reason: "window_invalid" });
  });

  test("windowEnd in the future → window_includes_future", () => {
    const r = validateCreateSession(
      mkArgs({
        windowEndAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );
    expect(r).toEqual({ ok: false, reason: "window_includes_future" });
  });

  test("windowEnd == now → window_includes_future", () => {
    const r = validateCreateSession(
      mkArgs({
        windowStartAt: new Date(now.getTime() - 86_400_000),
        windowEndAt: now,
      }),
    );
    expect(r).toEqual({ ok: false, reason: "window_includes_future" });
  });

  test("costCap below MIN_COST_CAP_USD → cost_cap_too_low", () => {
    const r = validateCreateSession(mkArgs({ costCapUsd: 0.01 }));
    expect(r).toEqual({ ok: false, reason: "cost_cap_too_low" });
  });

  test("costCap == MIN_COST_CAP_USD → ok", () => {
    expect(validateCreateSession(mkArgs({ costCapUsd: MIN_COST_CAP_USD }))).toEqual({ ok: true });
  });

  test("window exactly MAX_WINDOW_CANDLES on 1h → ok (300h)", () => {
    const start = new Date("2026-04-01T00:00:00.000Z");
    const end = new Date(start.getTime() + MAX_WINDOW_CANDLES * 60 * 60_000);
    expect(validateCreateSession(mkArgs({ windowStartAt: start, windowEndAt: end }))).toEqual({
      ok: true,
    });
  });

  test("window > MAX_WINDOW_CANDLES on 1h → window_too_large", () => {
    const start = new Date("2026-04-01T00:00:00.000Z");
    const end = new Date(start.getTime() + (MAX_WINDOW_CANDLES + 1) * 60 * 60_000);
    expect(validateCreateSession(mkArgs({ windowStartAt: start, windowEndAt: end }))).toEqual({
      ok: false,
      reason: "window_too_large",
    });
  });

  test("window cap depends on timeframe", () => {
    // 24h on 5m = 288 candles → still under cap
    const cfg5m = {
      timeframes: { primary: "5m" as Timeframe, higher: [] },
    } as unknown as WatchConfig;
    expect(
      validateCreateSession(
        mkArgs({
          watchConfig: cfg5m,
          windowStartAt: new Date("2026-04-12T00:00:00.000Z"),
          windowEndAt: new Date("2026-04-13T00:00:00.000Z"),
        }),
      ),
    ).toEqual({ ok: true });
    // 36h on 5m = 432 candles → over cap
    expect(
      validateCreateSession(
        mkArgs({
          watchConfig: cfg5m,
          windowStartAt: new Date("2026-04-11T00:00:00.000Z"),
          windowEndAt: new Date("2026-04-12T12:00:00.000Z"),
        }),
      ),
    ).toEqual({ ok: false, reason: "window_too_large" });
  });
});

describe("buildWorkflowId", () => {
  test("deterministic", () => {
    expect(buildWorkflowId("abc-123")).toBe("replay-session-abc-123");
    expect(buildWorkflowId("abc-123")).toBe(buildWorkflowId("abc-123"));
  });
});

describe("timeframeToMinutes", () => {
  const table: Array<[Timeframe, number]> = [
    ["1m", 1],
    ["5m", 5],
    ["15m", 15],
    ["30m", 30],
    ["1h", 60],
    ["2h", 120],
    ["4h", 240],
    ["1d", 1440],
    ["1w", 10080],
  ];
  for (const [tf, expected] of table) {
    test(`${tf} → ${expected} min`, () => {
      expect(timeframeToMinutes(tf)).toBe(expected);
    });
  }
});
