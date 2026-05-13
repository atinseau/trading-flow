import { describe, expect, test } from "bun:test";
import {
  DetectorTickProcessedPayload,
  FeedbackLessonProposedPayload,
  ReplayMetaPayload,
} from "@domain/events/replay/replayEventTypes";
import { EventPayloadSchema } from "@domain/events/schemas";

describe("DetectorTickProcessedPayload", () => {
  test("accepts ignoreReason string", () => {
    const r = DetectorTickProcessedPayload.safeParse({
      ignoreReason: "no clear pattern",
      reasoning: "compression, wait for break",
    });
    expect(r.success).toBe(true);
  });

  test("accepts null ignoreReason (setup created on this tick)", () => {
    const r = DetectorTickProcessedPayload.safeParse({ ignoreReason: null });
    expect(r.success).toBe(true);
  });

  test("rejects missing ignoreReason", () => {
    const r = DetectorTickProcessedPayload.safeParse({ reasoning: "x" });
    expect(r.success).toBe(false);
  });
});

describe("ReplayMetaPayload", () => {
  test("accepts each kind", () => {
    for (const kind of ["paused", "resumed", "cost_capped", "failed", "reset"]) {
      const r = ReplayMetaPayload.safeParse({ kind });
      expect(r.success).toBe(true);
    }
  });

  test("rejects unknown kind", () => {
    const r = ReplayMetaPayload.safeParse({ kind: "yolo" });
    expect(r.success).toBe(false);
  });
});

describe("FeedbackLessonProposedPayload", () => {
  test("accepts a complete CREATE action", () => {
    const r = FeedbackLessonProposedPayload.safeParse({
      action: "CREATE",
      title: "Avoid LONG against daily trend",
      body: "Don't propose LONG when daily regime is bearish and volume below MA20.",
      rationale: "This trade lost 0.8R despite high score. Daily was bearish, volume anemic.",
      sourceTradeSetupId: "11111111-1111-4111-8111-111111111111",
    });
    expect(r.success).toBe(true);
  });

  test("accepts REFINE with supersedesLessonId", () => {
    const r = FeedbackLessonProposedPayload.safeParse({
      action: "REFINE",
      title: "...",
      body: "...",
      rationale: "...",
      sourceTradeSetupId: "11111111-1111-4111-8111-111111111111",
      supersedesLessonId: "22222222-2222-4222-8222-222222222222",
    });
    expect(r.success).toBe(true);
  });

  test("rejects invalid action", () => {
    const r = FeedbackLessonProposedPayload.safeParse({
      action: "DELETE",
      title: "x",
      body: "y",
      rationale: "z",
      sourceTradeSetupId: "11111111-1111-4111-8111-111111111111",
    });
    expect(r.success).toBe(false);
  });

  test("rejects invalid uuid in sourceTradeSetupId", () => {
    const r = FeedbackLessonProposedPayload.safeParse({
      action: "CREATE",
      title: "x",
      body: "y",
      rationale: "z",
      sourceTradeSetupId: "not-a-uuid",
    });
    expect(r.success).toBe(false);
  });
});

describe("EventPayloadSchema discriminated union", () => {
  test("accepts DetectorTickProcessed via the union", () => {
    const r = EventPayloadSchema.safeParse({
      type: "DetectorTickProcessed",
      data: { ignoreReason: "no clear pattern" },
    });
    expect(r.success).toBe(true);
  });

  test("accepts ReplayMeta via the union", () => {
    const r = EventPayloadSchema.safeParse({
      type: "ReplayMeta",
      data: { kind: "cost_capped" },
    });
    expect(r.success).toBe(true);
  });

  test("accepts FeedbackLessonProposed via the union", () => {
    const r = EventPayloadSchema.safeParse({
      type: "FeedbackLessonProposed",
      data: {
        action: "CREATE",
        title: "x",
        body: "y",
        rationale: "z",
        sourceTradeSetupId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(r.success).toBe(true);
  });
});
