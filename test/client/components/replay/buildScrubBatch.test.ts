import { describe, expect, test } from "bun:test";
import {
  buildScrubBatch,
  estimateScrubCost,
  MAX_BATCH_TICKS,
} from "@client/components/replay/buildScrubBatch";

/**
 * Truth-table for the scrubber commit math. The cases that matter :
 *
 *  - forward N ticks                       → batch length N, no truncation
 *  - forward exactly at the boundary       → snap-down to the grid
 *  - forward past 50 ticks                 → batch length 50, truncated=true
 *  - backward                              → empty batch (drag-left is a pure view)
 *  - same position                         → empty batch
 *  - sub-tick forward                      → empty batch (round down)
 *  - degenerate timeframeMs (0/NaN)        → empty batch (defensive)
 */

const TF = 15 * 60_000; // 15 minutes

describe("buildScrubBatch — forward dispatches", () => {
  test("3 ticks forward → 3 tickAts, no truncation", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    const target = bot + 3 * TF;
    const b = buildScrubBatch({ botAtMs: bot, targetAtMs: target, timeframeMs: TF });
    expect(b.tickCount).toBe(3);
    expect(b.tickAts).toEqual([
      new Date(bot + 1 * TF).toISOString(),
      new Date(bot + 2 * TF).toISOString(),
      new Date(bot + 3 * TF).toISOString(),
    ]);
    expect(b.truncatedToMax).toBe(false);
    expect(b.effectiveTargetAt.getTime()).toBe(bot + 3 * TF);
  });

  test("sub-tick forward (less than 1 timeframe) → empty batch", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    const target = bot + TF - 60_000; // 14 minutes forward, less than 15
    const b = buildScrubBatch({ botAtMs: bot, targetAtMs: target, timeframeMs: TF });
    expect(b.tickCount).toBe(0);
    expect(b.tickAts).toEqual([]);
  });

  test("forward off-grid → snaps DOWN to the previous grid", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    // 3.7 ticks forward → 3 dispatched, the .7 is discarded.
    const target = bot + Math.round(3.7 * TF);
    const b = buildScrubBatch({ botAtMs: bot, targetAtMs: target, timeframeMs: TF });
    expect(b.tickCount).toBe(3);
    expect(b.effectiveTargetAt.getTime()).toBe(bot + 3 * TF);
  });
});

describe("buildScrubBatch — cap at MAX_BATCH_TICKS", () => {
  test("100 ticks requested → capped at 50, truncated flag set", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    const target = bot + 100 * TF;
    const b = buildScrubBatch({ botAtMs: bot, targetAtMs: target, timeframeMs: TF });
    expect(b.tickCount).toBe(MAX_BATCH_TICKS);
    expect(b.tickAts.length).toBe(MAX_BATCH_TICKS);
    expect(b.truncatedToMax).toBe(true);
    expect(b.effectiveTargetAt.getTime()).toBe(bot + MAX_BATCH_TICKS * TF);
  });

  test("exactly 50 → not truncated", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    const target = bot + MAX_BATCH_TICKS * TF;
    const b = buildScrubBatch({ botAtMs: bot, targetAtMs: target, timeframeMs: TF });
    expect(b.tickCount).toBe(MAX_BATCH_TICKS);
    expect(b.truncatedToMax).toBe(false);
  });
});

describe("buildScrubBatch — windowEnd clamp", () => {
  test("target beyond windowEnd → clamps to windowEnd before counting ticks", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    const windowEnd = bot + 3 * TF; // only 3 ticks fit in the session
    const target = bot + 100 * TF; // user drags way past
    const b = buildScrubBatch({
      botAtMs: bot,
      targetAtMs: target,
      timeframeMs: TF,
      windowEndMs: windowEnd,
    });
    expect(b.tickCount).toBe(3);
    expect(b.truncatedToMax).toBe(false); // clamped by window, not by MAX
    expect(b.effectiveTargetAt.getTime()).toBe(bot + 3 * TF);
  });

  test("target within windowEnd → window has no effect", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    const b = buildScrubBatch({
      botAtMs: bot,
      targetAtMs: bot + 5 * TF,
      timeframeMs: TF,
      windowEndMs: bot + 100 * TF,
    });
    expect(b.tickCount).toBe(5);
  });
});

describe("buildScrubBatch — backward / same / degenerate", () => {
  test("backward → empty", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    const b = buildScrubBatch({ botAtMs: bot, targetAtMs: bot - 10 * TF, timeframeMs: TF });
    expect(b.tickCount).toBe(0);
    expect(b.truncatedToMax).toBe(false);
  });

  test("same position → empty", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    const b = buildScrubBatch({ botAtMs: bot, targetAtMs: bot, timeframeMs: TF });
    expect(b.tickCount).toBe(0);
  });

  test("degenerate timeframeMs (0) → empty (defensive)", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    const b = buildScrubBatch({ botAtMs: bot, targetAtMs: bot + 10_000_000, timeframeMs: 0 });
    expect(b.tickCount).toBe(0);
  });

  test("degenerate timeframeMs (NaN) → empty", () => {
    const bot = new Date("2026-05-12T16:00:00Z").getTime();
    const b = buildScrubBatch({ botAtMs: bot, targetAtMs: bot + TF, timeframeMs: Number.NaN });
    expect(b.tickCount).toBe(0);
  });
});

describe("estimateScrubCost", () => {
  test("uses per-stage averages when available", () => {
    const cost = estimateScrubCost({
      costUsdSoFar: 50,
      ticksProcessed: 30,
      aliveSetupsCount: 2,
      detectorAvgUsdPerCall: 0.3,
      reviewerAvgUsdPerCall: 0.95,
      tickCount: 5,
    });
    // per tick = 0.3 + 0.95 * 2 = 2.2 ; * 5 = 11.0
    expect(cost).toBeCloseTo(11.0, 4);
  });

  test("falls back to running average when no per-stage data", () => {
    const cost = estimateScrubCost({
      costUsdSoFar: 60,
      ticksProcessed: 30,
      aliveSetupsCount: 1,
      detectorAvgUsdPerCall: null,
      reviewerAvgUsdPerCall: null,
      tickCount: 10,
    });
    // 60 / 30 = $2/tick * 10 = $20
    expect(cost).toBeCloseTo(20, 4);
  });

  test("falls back to flat $0.50/tick on a fresh session", () => {
    const cost = estimateScrubCost({
      costUsdSoFar: 0,
      ticksProcessed: 0,
      aliveSetupsCount: 0,
      detectorAvgUsdPerCall: null,
      reviewerAvgUsdPerCall: null,
      tickCount: 4,
    });
    expect(cost).toBe(2.0);
  });

  test("0 ticks → 0 cost regardless of session state", () => {
    const cost = estimateScrubCost({
      costUsdSoFar: 100,
      ticksProcessed: 100,
      aliveSetupsCount: 3,
      detectorAvgUsdPerCall: 0.5,
      reviewerAvgUsdPerCall: 1.0,
      tickCount: 0,
    });
    expect(cost).toBe(0);
  });
});
