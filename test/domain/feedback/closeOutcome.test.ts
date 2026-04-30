import { describe, expect, test } from "bun:test";
import {
  type CloseOutcome,
  deriveCloseOutcome,
  shouldTriggerFeedback,
} from "@domain/feedback/closeOutcome";

describe("deriveCloseOutcome", () => {
  test("sl_hit_direct from trackingResult", () => {
    const o = deriveCloseOutcome({
      finalStatus: "CLOSED",
      trackingResult: { reason: "sl_hit_direct" },
      everConfirmed: true,
    });
    expect(o).toEqual({ reason: "sl_hit_direct", everConfirmed: true });
  });

  test("sl_hit_after_tp1 from trackingResult", () => {
    const o = deriveCloseOutcome({
      finalStatus: "CLOSED",
      trackingResult: { reason: "sl_hit_after_tp1" },
      everConfirmed: true,
    });
    expect(o.reason).toBe("sl_hit_after_tp1");
  });

  test("price_invalidated from trackingResult", () => {
    const o = deriveCloseOutcome({
      finalStatus: "CLOSED",
      trackingResult: { reason: "price_invalidated" },
      everConfirmed: true,
    });
    expect(o.reason).toBe("price_invalidated");
  });

  test("all_tps_hit from trackingResult", () => {
    const o = deriveCloseOutcome({
      finalStatus: "CLOSED",
      trackingResult: { reason: "all_tps_hit" },
      everConfirmed: true,
    });
    expect(o.reason).toBe("all_tps_hit");
  });

  test("expired without trackingResult", () => {
    const o = deriveCloseOutcome({
      finalStatus: "EXPIRED",
      everConfirmed: false,
    });
    expect(o).toEqual({ reason: "expired", everConfirmed: false });
  });

  test("rejected without trackingResult", () => {
    const o = deriveCloseOutcome({
      finalStatus: "REJECTED",
      everConfirmed: false,
    });
    expect(o.reason).toBe("rejected");
  });

  test("never_confirmed when invalidated in REVIEWING", () => {
    const o = deriveCloseOutcome({
      finalStatus: "INVALIDATED",
      everConfirmed: false,
    });
    expect(o).toEqual({ reason: "never_confirmed", everConfirmed: false });
  });
});

describe("shouldTriggerFeedback", () => {
  const cases: { o: CloseOutcome; expected: boolean }[] = [
    { o: { reason: "sl_hit_direct", everConfirmed: true }, expected: true },
    { o: { reason: "sl_hit_after_tp1", everConfirmed: true }, expected: true },
    { o: { reason: "price_invalidated", everConfirmed: true }, expected: true },
    { o: { reason: "all_tps_hit", everConfirmed: true }, expected: false }, // v1 OUT-OF-SCOPE
    { o: { reason: "expired", everConfirmed: false }, expected: false },
    { o: { reason: "rejected", everConfirmed: false }, expected: false },
    { o: { reason: "never_confirmed", everConfirmed: false }, expected: false },
    { o: { reason: "sl_hit_direct", everConfirmed: false }, expected: false }, // safety: must be confirmed
  ];

  for (const { o, expected } of cases) {
    test(`${o.reason} (everConfirmed=${o.everConfirmed}) → ${expected}`, () => {
      expect(shouldTriggerFeedback(o)).toBe(expected);
    });
  }
});
