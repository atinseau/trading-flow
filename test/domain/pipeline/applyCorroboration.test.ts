import { describe, expect, test } from "bun:test";
import { applyCorroboration } from "@domain/pipeline/applyCorroboration";

const baseState = {
  status: "REVIEWING" as const,
  score: 33,
  invalidationLevel: 50_000,
  direction: "LONG" as const,
};

const baseScoring = {
  scoreMax: 100,
  scoreThresholdFinalizer: 80,
  scoreThresholdDead: 10,
};

describe("applyCorroboration", () => {
  test("delta=0 → noop", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: 0,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("noop");
  });

  test("delta=+5 REVIEWING → Strengthened, score 33→38, status unchanged", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: 5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.event.type).toBe("Strengthened");
    expect(r.event.scoreDelta).toBe(5);
    expect(r.event.scoreAfter).toBe(38);
    expect(r.event.statusAfter).toBe("REVIEWING");
    expect(r.next.score).toBe(38);
    expect(r.event.payload).toMatchObject({
      type: "Strengthened",
      data: { source: "detector_corroboration" },
    });
  });

  test("delta=+50 clamps to scoreMax=80", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: 50,
      scoring: { ...baseScoring, scoreMax: 80 },
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.next.score).toBe(80);
    expect(r.event.scoreDelta).toBe(47);
  });

  test("crosses scoreThresholdFinalizer → status FINALIZING", () => {
    const r = applyCorroboration({
      state: { ...baseState, score: 75 },
      delta: 10,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.event.statusAfter).toBe("FINALIZING");
    expect(r.next.status).toBe("FINALIZING");
  });

  test("delta=-5 REVIEWING → Weakened, score 33→28", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: -5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.event.type).toBe("Weakened");
    expect(r.event.scoreDelta).toBe(-5);
    expect(r.event.scoreAfter).toBe(28);
    expect(r.event.payload).toMatchObject({
      type: "Weakened",
      data: { source: "detector_decorroboration" },
    });
  });

  test("delta=-50 floors to 0", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: -50,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.next.score).toBe(0);
    expect(r.event.scoreDelta).toBe(-33);
  });

  test("score crosses ≤ scoreThresholdDead → EXPIRED", () => {
    const r = applyCorroboration({
      state: { ...baseState, score: 15 },
      delta: -5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.event.statusAfter).toBe("EXPIRED");
    expect(r.next.status).toBe("EXPIRED");
  });

  test("status FINALIZING → ignored", () => {
    const r = applyCorroboration({
      state: { ...baseState, status: "FINALIZING" },
      delta: 5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("ignored");
  });

  test("status TRACKING → ignored", () => {
    const r = applyCorroboration({
      state: { ...baseState, status: "TRACKING" },
      delta: -10,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("ignored");
  });

  test("status REJECTED → ignored", () => {
    const r = applyCorroboration({
      state: { ...baseState, status: "REJECTED" },
      delta: 5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("ignored");
  });

  test("event carries detectorPromptVersion as actor", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: 5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v7",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.event.actor).toBe("detector_v7");
    expect(r.event.stage).toBe("detector");
  });

  test("preserves invalidationLevel and direction in next", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: 5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.next.invalidationLevel).toBe(50_000);
    expect(r.next.direction).toBe("LONG");
  });

  test("exact boundary: newScore === scoreThresholdFinalizer → FINALIZING", () => {
    // score=70 + delta=10 = 80, threshold_finalizer=80 → must trigger the >= branch
    const r = applyCorroboration({
      state: { ...baseState, score: 70 },
      delta: 10,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.next.score).toBe(80);
    expect(r.event.statusAfter).toBe("FINALIZING");
  });

  test("score=0 + delta=+5 with dead=0 → Strengthened (floor + positive delta combine)", () => {
    // Locks the score=0 floor behavior: when delta is positive, the score
    // moves up rather than being stuck at the floor. Dead threshold is
    // also at 0, so the EXPIRED branch must NOT fire on the way up.
    const r = applyCorroboration({
      state: { ...baseState, score: 0 },
      delta: 5,
      scoring: { ...baseScoring, scoreThresholdDead: 0 },
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.next.score).toBe(5);
    expect(r.event.type).toBe("Strengthened");
    expect(r.event.statusAfter).toBe("REVIEWING");
  });
});
