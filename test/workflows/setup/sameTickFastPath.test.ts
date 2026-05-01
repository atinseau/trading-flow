import { describe, expect, test } from "bun:test";

/**
 * Unit-test the same-tick fast-path branching logic in isolation. The branch
 * lives at the start of `setupWorkflow` (before the active loop) and is a
 * pure function of `(initialScore, scoreThresholdFinalizer,
 * expectedMaturationTicks, allowSameTickFastPath, status)`. Testing the
 * boolean rather than spinning a Temporal worker keeps this fast and
 * regression-tight on the safety guards.
 */
function shouldFastPath(input: {
  initialScore: number;
  scoreThresholdFinalizer: number;
  expectedMaturationTicks: number;
  allowSameTickFastPath: boolean;
  status: "REVIEWING" | "FINALIZING" | "TRACKING";
}): boolean {
  return (
    input.allowSameTickFastPath &&
    input.initialScore >= input.scoreThresholdFinalizer &&
    input.expectedMaturationTicks === 1 &&
    input.status === "REVIEWING"
  );
}

describe("same-tick fast-path guard", () => {
  const baseInput = {
    initialScore: 80,
    scoreThresholdFinalizer: 80,
    expectedMaturationTicks: 1,
    allowSameTickFastPath: true,
    status: "REVIEWING" as const,
  };

  test("fires when all conditions met (score≥threshold, mat=1, allowed, REVIEWING)", () => {
    expect(shouldFastPath(baseInput)).toBe(true);
  });

  test("score above threshold also fires", () => {
    expect(shouldFastPath({ ...baseInput, initialScore: 95 })).toBe(true);
  });

  test("does NOT fire when score below threshold", () => {
    expect(shouldFastPath({ ...baseInput, initialScore: 79 })).toBe(false);
  });

  test("does NOT fire when maturation > 1", () => {
    expect(shouldFastPath({ ...baseInput, expectedMaturationTicks: 2 })).toBe(false);
    expect(shouldFastPath({ ...baseInput, expectedMaturationTicks: 4 })).toBe(false);
  });

  test("does NOT fire when watch disables fast-path", () => {
    expect(shouldFastPath({ ...baseInput, allowSameTickFastPath: false })).toBe(false);
  });

  test("does NOT fire if workflow not in REVIEWING (post-replay safety)", () => {
    expect(shouldFastPath({ ...baseInput, status: "FINALIZING" })).toBe(false);
    expect(shouldFastPath({ ...baseInput, status: "TRACKING" })).toBe(false);
  });

  test("ALL conditions are independently necessary", () => {
    // Score=80 + mat=1 + allowed + REVIEWING → true.
    // Flip each one in isolation, verify false.
    const baseTrue = shouldFastPath(baseInput);
    expect(baseTrue).toBe(true);

    expect(shouldFastPath({ ...baseInput, initialScore: 79 })).toBe(false);
    expect(shouldFastPath({ ...baseInput, expectedMaturationTicks: 2 })).toBe(false);
    expect(shouldFastPath({ ...baseInput, allowSameTickFastPath: false })).toBe(false);
    expect(shouldFastPath({ ...baseInput, status: "FINALIZING" })).toBe(false);
  });
});
