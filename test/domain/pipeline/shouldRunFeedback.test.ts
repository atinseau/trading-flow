import { describe, expect, test } from "bun:test";
import { shouldRunFeedback } from "@domain/pipeline/shouldRunFeedback";

const slHitDirect = { reason: "sl_hit_direct" as const, everConfirmed: true };
const allTpsHit = { reason: "all_tps_hit" as const, everConfirmed: true };
const expired = { reason: "expired" as const, everConfirmed: false };

describe("shouldRunFeedback", () => {
  test("SL hit + watch enabled + no session mode (live default) → true", () => {
    expect(shouldRunFeedback({ closeOutcome: slHitDirect, watchFeedbackEnabled: true })).toBe(true);
  });

  test("All TPs hit (winner) → false even when everything else enabled", () => {
    expect(shouldRunFeedback({ closeOutcome: allTpsHit, watchFeedbackEnabled: true })).toBe(false);
  });

  test("Expired (never confirmed) → false", () => {
    expect(shouldRunFeedback({ closeOutcome: expired, watchFeedbackEnabled: true })).toBe(false);
  });

  test("SL hit + watch DISABLED → false (Drift G fix)", () => {
    expect(shouldRunFeedback({ closeOutcome: slHitDirect, watchFeedbackEnabled: false })).toBe(
      false,
    );
  });

  test("SL hit + watch enabled + session mode='skip' → false (replay override)", () => {
    expect(
      shouldRunFeedback({
        closeOutcome: slHitDirect,
        watchFeedbackEnabled: true,
        sessionFeedbackMode: "skip",
      }),
    ).toBe(false);
  });

  test("SL hit + watch enabled + session mode='run' → true", () => {
    expect(
      shouldRunFeedback({
        closeOutcome: slHitDirect,
        watchFeedbackEnabled: true,
        sessionFeedbackMode: "run",
      }),
    ).toBe(true);
  });

  test("SL hit + watch disabled + session mode='run' → false (watch wins)", () => {
    expect(
      shouldRunFeedback({
        closeOutcome: slHitDirect,
        watchFeedbackEnabled: false,
        sessionFeedbackMode: "run",
      }),
    ).toBe(false);
  });
});
