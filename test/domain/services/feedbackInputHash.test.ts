import { computeFeedbackInputHash } from "@domain/services/feedbackInputHash";
import { describe, expect, test } from "bun:test";

describe("computeFeedbackInputHash", () => {
  test("is deterministic for same inputs", () => {
    const a = computeFeedbackInputHash({
      promptVersion: "feedback_v1",
      contextChunkHashes: ["a", "b"],
      existingLessonIds: ["11111111-1111-1111-1111-111111111111"],
    });
    const b = computeFeedbackInputHash({
      promptVersion: "feedback_v1",
      contextChunkHashes: ["a", "b"],
      existingLessonIds: ["11111111-1111-1111-1111-111111111111"],
    });
    expect(a).toBe(b);
  });

  test("changes when promptVersion changes", () => {
    const a = computeFeedbackInputHash({
      promptVersion: "feedback_v1",
      contextChunkHashes: ["a"],
      existingLessonIds: [],
    });
    const b = computeFeedbackInputHash({
      promptVersion: "feedback_v2",
      contextChunkHashes: ["a"],
      existingLessonIds: [],
    });
    expect(a).not.toBe(b);
  });

  test("is order-independent for existingLessonIds", () => {
    const a = computeFeedbackInputHash({
      promptVersion: "feedback_v1",
      contextChunkHashes: ["a"],
      existingLessonIds: ["b", "a"],
    });
    const b = computeFeedbackInputHash({
      promptVersion: "feedback_v1",
      contextChunkHashes: ["a"],
      existingLessonIds: ["a", "b"],
    });
    expect(a).toBe(b);
  });
});
