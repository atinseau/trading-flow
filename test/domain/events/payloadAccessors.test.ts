import { describe, expect, test } from "bun:test";
import { extractObservations, extractReasoning } from "@domain/events/payloadAccessors";
import type { EventPayload } from "@domain/events/schemas";

/**
 * Unit tests for the shared payload accessor helpers used by both the
 * live setup reviewer prompt builder and the replay activity. The
 * helpers are tiny, but they're consumed by code that decides what the
 * LLM sees — silent bugs here propagate to prompts.
 */

describe("extractObservations", () => {
  test("returns observations for Strengthened", () => {
    const p: EventPayload = {
      type: "Strengthened",
      data: {
        reasoning: "ok",
        observations: [{ kind: "trend", text: "up" }],
        source: "reviewer_full",
      },
    };
    expect(extractObservations(p)).toEqual([{ kind: "trend", text: "up" }]);
  });

  test("returns observations for Weakened", () => {
    const p: EventPayload = {
      type: "Weakened",
      data: {
        reasoning: "ok",
        observations: [{ kind: "vol", text: "drop" }],
        source: "reviewer_full",
      },
    };
    expect(extractObservations(p)).toEqual([{ kind: "vol", text: "drop" }]);
  });

  test("returns observations for Neutral", () => {
    const p: EventPayload = { type: "Neutral", data: { observations: [{ kind: "x", text: "y" }] } };
    expect(extractObservations(p)).toEqual([{ kind: "x", text: "y" }]);
  });

  test("returns [] for unrelated event types", () => {
    const p: EventPayload = {
      type: "SetupCreated",
      data: {
        pattern: "engulfing",
        direction: "LONG",
        keyLevels: { invalidation: 0 },
        initialScore: 50,
        rawObservation: "",
      },
    };
    expect(extractObservations(p)).toEqual([]);
  });
});

describe("extractReasoning", () => {
  test("returns reasoning for Strengthened", () => {
    const p: EventPayload = {
      type: "Strengthened",
      data: { reasoning: "trend up", observations: [], source: "reviewer_full" },
    };
    expect(extractReasoning(p)).toBe("trend up");
  });

  test("returns reasoning for Weakened", () => {
    const p: EventPayload = {
      type: "Weakened",
      data: { reasoning: "trend down", observations: [], source: "reviewer_full" },
    };
    expect(extractReasoning(p)).toBe("trend down");
  });

  test("returns null for Neutral (no reasoning field)", () => {
    const p: EventPayload = { type: "Neutral", data: { observations: [] } };
    expect(extractReasoning(p)).toBeNull();
  });

  test("returns null for SetupCreated and other types", () => {
    const p: EventPayload = {
      type: "SetupCreated",
      data: {
        pattern: "x",
        direction: "LONG",
        keyLevels: { invalidation: 0 },
        initialScore: 50,
        rawObservation: "",
      },
    };
    expect(extractReasoning(p)).toBeNull();
  });
});
