import { describe, expect, test } from "bun:test";
import { applyPriceCheck } from "@domain/pipeline/applyPriceCheck";

const baseLong = {
  status: "REVIEWING" as const,
  score: 42,
  invalidationLevel: 50_000,
  direction: "LONG" as const,
};

describe("applyPriceCheck", () => {
  test("LONG breach (price < invalidation) in REVIEWING → applied", () => {
    const r = applyPriceCheck({
      state: baseLong,
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.next.status).toBe("INVALIDATED");
    expect(r.event.type).toBe("PriceInvalidated");
    expect(r.event.actor).toBe("price_monitor");
  });

  test("LONG breach in FINALIZING → applied", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, status: "FINALIZING" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("applied");
  });

  test("LONG no breach (price >= invalidation) → not_breached", () => {
    const r = applyPriceCheck({
      state: baseLong,
      currentPrice: 50_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_breached");
  });

  test("LONG equal to invalidation level → not_breached (strict less-than)", () => {
    const r = applyPriceCheck({
      state: baseLong,
      currentPrice: 50_000,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_breached");
  });

  test("SHORT breach (price > invalidation) → applied", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, direction: "SHORT" },
      currentPrice: 50_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("applied");
  });

  test("SHORT no breach → not_breached", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, direction: "SHORT" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_breached");
  });

  test("status TRACKING → not_active (trackingLoop handles)", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, status: "TRACKING" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_active");
  });

  test("status INVALIDATED (terminal) → not_active", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, status: "INVALIDATED" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_active");
  });

  test("status CLOSED (terminal) → not_active", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, status: "CLOSED" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_active");
  });
});
