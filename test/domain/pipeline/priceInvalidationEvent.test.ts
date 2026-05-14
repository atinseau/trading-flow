import { describe, expect, test } from "bun:test";
import { EventPayloadSchema } from "@domain/events/schemas";
import { buildPriceInvalidationEvent } from "@domain/pipeline/priceInvalidationEvent";

describe("buildPriceInvalidationEvent", () => {
  const baseState = {
    status: "REVIEWING" as const,
    score: 42,
    invalidationLevel: 50_000,
    direction: "LONG" as const,
  };

  test("trigger='price_monitor' (live REVIEWING/FINALIZING)", () => {
    const evt = buildPriceInvalidationEvent({
      state: baseState,
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:30:00.000Z",
      trigger: "price_monitor",
    });
    expect(evt.type).toBe("PriceInvalidated");
    expect(evt.stage).toBe("system");
    expect(evt.actor).toBe("price_monitor");
    expect(evt.scoreDelta).toBe(0);
    expect(evt.scoreAfter).toBe(42);
    expect(evt.statusBefore).toBe("REVIEWING");
    expect(evt.statusAfter).toBe("INVALIDATED");
    expect(evt.payload.type).toBe("PriceInvalidated");
    expect(evt.payload.data).toMatchObject({
      currentPrice: 49_500,
      invalidationLevel: 50_000,
      observedAt: "2026-05-14T10:30:00.000Z",
    });
  });

  test("trigger='tracker' (TRACKING-time invalidation)", () => {
    const evt = buildPriceInvalidationEvent({
      state: { ...baseState, status: "TRACKING" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T11:00:00.000Z",
      trigger: "tracker",
    });
    expect(evt.actor).toBe("tracker");
    expect(evt.statusBefore).toBe("TRACKING");
    expect(evt.statusAfter).toBe("INVALIDATED");
    expect(evt.type).toBe("PriceInvalidated");
  });

  test("preserves scoreAfter from state.score regardless of trigger", () => {
    const evt = buildPriceInvalidationEvent({
      state: { ...baseState, score: 73 },
      currentPrice: 49_000,
      observedAt: "2026-05-14T10:00:00.000Z",
      trigger: "price_monitor",
    });
    expect(evt.scoreAfter).toBe(73);
  });

  test("schema allows optional telegramPreview to be attached post-build", () => {
    const evt = buildPriceInvalidationEvent({
      state: { ...baseState, status: "TRACKING" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T11:00:00.000Z",
      trigger: "tracker",
    });
    const withPreview = {
      ...evt,
      payload: {
        ...evt.payload,
        data: { ...evt.payload.data, telegramPreview: "✋ NEUTRALISÉ" },
      },
    };
    // Verify the discriminated-union schema accepts the optional field.
    const parsed = EventPayloadSchema.parse(withPreview.payload);
    expect(parsed.type).toBe("PriceInvalidated");
    expect(withPreview.payload.data.telegramPreview).toBe("✋ NEUTRALISÉ");
  });
});
