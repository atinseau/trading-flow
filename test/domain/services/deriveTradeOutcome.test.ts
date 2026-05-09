import { describe, expect, test } from "bun:test";
import type { EventPayload } from "@domain/events/schemas";
import { deriveTradeOutcome, type EventWithPayload } from "@domain/services/deriveTradeOutcome";

const ev = (
  type: string,
  sequence: number,
  payload: EventPayload | null = null,
): EventWithPayload => ({ type, sequence, payload });

const confirmedPayload = (entry: number, sl: number, tp: number[]): EventPayload => ({
  type: "Confirmed",
  data: { decision: "GO", entry, stopLoss: sl, takeProfit: tp, reasoning: "x" },
});

const tpPayload = (level: number, index: number): EventPayload => ({
  type: "TPHit",
  data: { level, index, observedAt: new Date().toISOString() },
});

const slPayload = (level: number): EventPayload => ({
  type: "SLHit",
  data: { level, observedAt: new Date().toISOString() },
});

const filledPayload: EventPayload = {
  type: "EntryFilled",
  data: { fillPrice: 100, observedAt: new Date().toISOString() },
};

describe("deriveTradeOutcome", () => {
  test("returns null when no direction", () => {
    expect(
      deriveTradeOutcome({
        direction: null,
        events: [ev("Confirmed", 1, confirmedPayload(100, 90, [110]))],
      }),
    ).toBeNull();
  });

  test("returns null when no Confirmed event", () => {
    expect(
      deriveTradeOutcome({
        direction: "LONG",
        events: [ev("SetupCreated", 1)],
      }),
    ).toBeNull();
  });

  test("returns null when not yet entered (no EntryFilled)", () => {
    expect(
      deriveTradeOutcome({
        direction: "LONG",
        events: [ev("Confirmed", 1, confirmedPayload(100, 90, [110]))],
      }),
    ).toBeNull();
  });

  test("LONG TP hit → TP_HIT exit reason, +1R", () => {
    const out = deriveTradeOutcome({
      direction: "LONG",
      events: [
        ev("Confirmed", 1, confirmedPayload(100, 90, [110])),
        ev("EntryFilled", 2, filledPayload),
        ev("TPHit", 3, tpPayload(110, 0)),
      ],
    });
    expect(out).not.toBeNull();
    expect(out?.exitReason).toBe("TP_HIT");
    expect(out?.exitPrice).toBe(110);
    expect(out?.metrics.rMultiple).toBeCloseTo(1.0, 5);
  });

  test("LONG SL hit → SL_HIT exit reason, -1R", () => {
    const out = deriveTradeOutcome({
      direction: "LONG",
      events: [
        ev("Confirmed", 1, confirmedPayload(100, 90, [110])),
        ev("EntryFilled", 2, filledPayload),
        ev("SLHit", 3, slPayload(90)),
      ],
    });
    expect(out?.exitReason).toBe("SL_HIT");
    expect(out?.metrics.rMultiple).toBeCloseTo(-1.0, 5);
  });

  test("Trailed-to-BE then SL: SL_HIT at entry price → 0R", () => {
    // After TP1, trailing moves SL to entry. If price returns to BE, SLHit
    // fires at entry level — net 0R outcome.
    const out = deriveTradeOutcome({
      direction: "LONG",
      events: [
        ev("Confirmed", 1, confirmedPayload(100, 90, [110, 120])),
        ev("EntryFilled", 2, filledPayload),
        ev("TPHit", 3, tpPayload(110, 0)),
        ev("TrailingMoved", 4, {
          type: "TrailingMoved",
          data: { newStopLoss: 100, reason: "be_after_tp1" },
        }),
        ev("SLHit", 5, slPayload(100)),
      ],
    });
    expect(out?.exitReason).toBe("SL_HIT");
    expect(out?.exitPrice).toBe(100);
    expect(out?.metrics.rMultiple).toBeCloseTo(0, 5);
  });

  test("Multiple TPs hit, last TP wins as exit price", () => {
    const out = deriveTradeOutcome({
      direction: "LONG",
      events: [
        ev("Confirmed", 1, confirmedPayload(100, 90, [110, 120])),
        ev("EntryFilled", 2, filledPayload),
        ev("TPHit", 3, tpPayload(110, 0)),
        ev("TPHit", 4, tpPayload(120, 1)),
      ],
    });
    expect(out?.exitReason).toBe("TP_HIT");
    expect(out?.exitPrice).toBe(120);
    expect(out?.metrics.rMultiple).toBeCloseTo(2.0, 5);
  });

  test("INVALIDATED post-trade with priceAtInvalidation", () => {
    const out = deriveTradeOutcome({
      direction: "LONG",
      events: [
        ev("Confirmed", 1, confirmedPayload(100, 90, [110])),
        ev("EntryFilled", 2, filledPayload),
        ev("Invalidated", 3, {
          type: "Invalidated",
          data: {
            reason: "structure_break_post_entry",
            trigger: "structure_break",
            priceAtInvalidation: 95,
            invalidationLevel: 92,
            deterministic: true,
          },
        }),
      ],
    });
    expect(out?.exitReason).toBe("INVALIDATED");
    expect(out?.exitPrice).toBe(95);
    expect(out?.metrics.rMultiple).toBeCloseTo(-0.5, 5);
  });

  test("Expired without TP/SL → null (cannot infer exit price)", () => {
    expect(
      deriveTradeOutcome({
        direction: "LONG",
        events: [
          ev("Confirmed", 1, confirmedPayload(100, 90, [110])),
          ev("EntryFilled", 2, filledPayload),
          ev("Expired", 3, {
            type: "Expired",
            data: { reason: "ttl_reached", ttlExpiresAt: new Date().toISOString() },
          }),
        ],
      }),
    ).toBeNull();
  });

  test("SHORT TP hit → +R", () => {
    const out = deriveTradeOutcome({
      direction: "SHORT",
      events: [
        ev("Confirmed", 1, confirmedPayload(100, 110, [80])),
        ev("EntryFilled", 2, filledPayload),
        ev("TPHit", 3, tpPayload(80, 0)),
      ],
    });
    expect(out?.metrics.rMultiple).toBeCloseTo(2.0, 5);
    expect(out?.metrics.pnlPct).toBeCloseTo(20, 5);
  });
});
