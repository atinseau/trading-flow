import { describe, expect, test } from "bun:test";
import { FakeClock } from "@test-fakes/FakeClock";
import { buildSchedulerActivities } from "@workflows/scheduler/activities";

/**
 * Regression test: the detector prompt schema returns snake_case
 * (key_levels, initial_score, raw_observation), but ProposedSetup is
 * camelCase. The dedupNewSetups activity must normalize at the boundary
 * before invoking the dedup domain function — otherwise the workflow's
 * `newSetup.keyLevels.invalidation` access throws TypeError when wiring the
 * setup as a child workflow.
 */
describe("dedupNewSetups activity — snake_case → camelCase normalization", () => {
  const watch = {
    deduplication: {
      similar_setup_window_candles: 5,
      similar_price_tolerance_pct: 0.5,
    },
  };
  const deps = {
    watchById: async () => watch,
    clock: new FakeClock(new Date("2026-04-30T10:00:00Z")),
  } as unknown as Parameters<typeof buildSchedulerActivities>[0];

  test("LLM-shaped (snake_case) input is normalized to camelCase ProposedSetup", async () => {
    const activities = buildSchedulerActivities(deps);
    const result = await activities.dedupNewSetups({
      watchId: "test",
      aliveSetupsJson: "[]",
      newSetupsJson: JSON.stringify([
        {
          type: "bb_squeeze_breakdown",
          direction: "SHORT",
          key_levels: { entry: 76140, invalidation: 76260, target: 75680 },
          initial_score: 25,
          raw_observation: "test obs",
        },
      ]),
    });
    expect(result.creates.length).toBe(1);
    const created = result.creates[0];
    expect(created).toBeDefined();
    if (!created) return;
    // Critical: keyLevels is the camelCase shape the workflow consumes.
    expect(created.keyLevels.invalidation).toBe(76260);
    expect(created.keyLevels.entry).toBe(76140);
    expect(created.keyLevels.target).toBe(75680);
    expect(created.initialScore).toBe(25);
    expect(created.rawObservation).toBe("test obs");
    expect(created.type).toBe("bb_squeeze_breakdown");
    expect(created.direction).toBe("SHORT");
  });
});
