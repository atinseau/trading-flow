import { expect, test } from "bun:test";
import type { SetupRuntimeState } from "@domain/scoring/applyVerdict";
import { applyVerdict } from "@domain/scoring/applyVerdict";

const baseState: SetupRuntimeState = {
  status: "REVIEWING",
  score: 50,
  invalidationLevel: 41500,
  direction: "LONG",
};
const config = {
  scoreMax: 100,
  scoreThresholdFinalizer: 80,
  scoreThresholdDead: 10,
};

test("STRENGTHEN raises score, capped at scoreMax", () => {
  const next = applyVerdict(
    { ...baseState, score: 95 },
    { type: "STRENGTHEN", scoreDelta: 10, observations: [], reasoning: "" },
    config,
  );
  expect(next.score).toBe(100);
  expect(next.status).toBe("REVIEWING");
});

test("STRENGTHEN crossing finalizer threshold sets status FINALIZING", () => {
  const next = applyVerdict(
    { ...baseState, score: 75 },
    { type: "STRENGTHEN", scoreDelta: 10, observations: [], reasoning: "" },
    config,
  );
  expect(next.score).toBe(85);
  expect(next.status).toBe("FINALIZING");
});

test("WEAKEN below dead threshold sets status EXPIRED", () => {
  const next = applyVerdict(
    { ...baseState, score: 12 },
    { type: "WEAKEN", scoreDelta: -5, observations: [], reasoning: "" },
    config,
  );
  expect(next.score).toBe(7);
  expect(next.status).toBe("EXPIRED");
});

test("INVALIDATE sets status INVALIDATED, score unchanged for audit", () => {
  const next = applyVerdict(baseState, { type: "INVALIDATE", reason: "structure_break" }, config);
  expect(next.score).toBe(50);
  expect(next.status).toBe("INVALIDATED");
});

test("NEUTRAL leaves score and status unchanged", () => {
  const next = applyVerdict(baseState, { type: "NEUTRAL", observations: [] }, config);
  expect(next.score).toBe(50);
  expect(next.status).toBe("REVIEWING");
});

test("invalidationLevelUpdate is applied if STRENGTHEN provides one", () => {
  const next = applyVerdict(
    baseState,
    {
      type: "STRENGTHEN",
      scoreDelta: 5,
      observations: [],
      reasoning: "",
      invalidationLevelUpdate: 41700,
    },
    config,
  );
  expect(next.invalidationLevel).toBe(41700);
});

test("score never goes below 0", () => {
  const next = applyVerdict(
    { ...baseState, score: 5 },
    { type: "WEAKEN", scoreDelta: -50, observations: [], reasoning: "" },
    config,
  );
  expect(next.score).toBe(0);
  expect(next.status).toBe("EXPIRED");
});
