import { expect, test } from "bun:test";
import { dedupNewSetups } from "@workflows/scheduler/dedup";

const cfg = { similarSetupWindowCandles: 5, similarPriceTolerancePct: 0.5 };

test("proposed setup similar to alive → corroborate", () => {
  const proposed = [
    {
      type: "double_bottom",
      direction: "LONG" as const,
      keyLevels: { invalidation: 41800 },
      initialScore: 25,
      rawObservation: "x",
    },
  ];
  const alive = [
    {
      id: "abc",
      workflowId: "wf-abc",
      asset: "BTC",
      timeframe: "1h",
      status: "REVIEWING" as const,
      currentScore: 50,
      invalidationLevel: 41805,
      direction: "LONG" as const,
      patternHint: "double_bottom",
      ageInCandles: 2,
    },
  ];
  const r = dedupNewSetups(proposed, alive, cfg);
  expect(r.creates).toHaveLength(0);
  expect(r.corroborateInstead).toHaveLength(1);
  expect(r.corroborateInstead[0]?.setupId).toBe("abc");
});

test("proposed setup with different direction → create", () => {
  const proposed = [
    {
      type: "double_bottom",
      direction: "SHORT" as const,
      keyLevels: { invalidation: 41800 },
      initialScore: 25,
      rawObservation: "x",
    },
  ];
  const alive = [
    {
      id: "abc",
      workflowId: "wf-abc",
      asset: "BTC",
      timeframe: "1h",
      status: "REVIEWING" as const,
      currentScore: 50,
      invalidationLevel: 41805,
      direction: "LONG" as const,
      patternHint: "double_bottom",
      ageInCandles: 2,
    },
  ];
  const r = dedupNewSetups(proposed, alive, cfg);
  expect(r.creates).toHaveLength(1);
});

test("alive setup too old → create new", () => {
  const proposed = [
    {
      type: "double_bottom",
      direction: "LONG" as const,
      keyLevels: { invalidation: 41800 },
      initialScore: 25,
      rawObservation: "x",
    },
  ];
  const alive = [
    {
      id: "abc",
      workflowId: "wf-abc",
      asset: "BTC",
      timeframe: "1h",
      status: "REVIEWING" as const,
      currentScore: 50,
      invalidationLevel: 41805,
      direction: "LONG" as const,
      patternHint: "double_bottom",
      ageInCandles: 10,
    },
  ];
  const r = dedupNewSetups(proposed, alive, cfg);
  expect(r.creates).toHaveLength(1);
});
