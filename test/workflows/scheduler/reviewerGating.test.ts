import { describe, expect, test } from "bun:test";
import { shouldSendReviewSignal } from "@workflows/scheduler/reviewerGating";

/**
 * Truth-table coverage of the review-signal gating decision. This is the
 * gate that, pre-fix, was hardcoded to "skip on any corroboration" and
 * silently killed every reviewer LLM call in production (observed : 0
 * reviewer calls in 7 days, 48 detector calls).
 *
 * The four axes (corroborated × flag) MUST all behave per the design
 * intent : reviewer is part of the pipeline by default, only opted out
 * explicitly via the config knob.
 */
describe("shouldSendReviewSignal", () => {
  const setupA = "setup-a";
  const noCorroborations: ReadonlySet<string> = new Set();
  const corroboratedA: ReadonlySet<string> = new Set([setupA]);

  test("not corroborated + flag off → send review (default pipeline)", () => {
    expect(
      shouldSendReviewSignal({
        setupId: setupA,
        corroboratedIds: noCorroborations,
        reviewerSkipOnCorroborate: false,
      }),
    ).toBe(true);
  });

  test("not corroborated + flag on → send review (the flag only gates the corroborated path)", () => {
    expect(
      shouldSendReviewSignal({
        setupId: setupA,
        corroboratedIds: noCorroborations,
        reviewerSkipOnCorroborate: true,
      }),
    ).toBe(true);
  });

  test("corroborated + flag off (default) → still send review", () => {
    // THIS is the regression case : pre-fix, the scheduler skipped review
    // for every corroborated setup, regardless of the flag. The result was
    // 0 reviewer calls in production because the detector kept corroborating.
    expect(
      shouldSendReviewSignal({
        setupId: setupA,
        corroboratedIds: corroboratedA,
        reviewerSkipOnCorroborate: false,
      }),
    ).toBe(true);
  });

  test("corroborated + flag on → skip review (opt-in cost optimization)", () => {
    expect(
      shouldSendReviewSignal({
        setupId: setupA,
        corroboratedIds: corroboratedA,
        reviewerSkipOnCorroborate: true,
      }),
    ).toBe(false);
  });

  test("multiple alive setups, only one corroborated, flag on → reviewer runs for the non-corroborated", () => {
    const setupB = "setup-b";
    const corroborated = new Set([setupA]);
    expect(
      shouldSendReviewSignal({
        setupId: setupA,
        corroboratedIds: corroborated,
        reviewerSkipOnCorroborate: true,
      }),
    ).toBe(false);
    expect(
      shouldSendReviewSignal({
        setupId: setupB,
        corroboratedIds: corroborated,
        reviewerSkipOnCorroborate: true,
      }),
    ).toBe(true);
  });
});
