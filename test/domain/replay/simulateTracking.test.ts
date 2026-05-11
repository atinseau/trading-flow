import { describe, expect, test } from "bun:test";
import {
  closeReasonFromState,
  initialTrackingState,
  simulateCandleTracking,
} from "@domain/replay/simulateTracking";
import type { Candle } from "@domain/schemas/Candle";

function candle(args: { ts: string; o: number; h: number; l: number; c: number }): Candle {
  return {
    timestamp: new Date(args.ts),
    open: args.o,
    high: args.h,
    low: args.l,
    close: args.c,
    volume: 100,
  };
}

describe("simulateCandleTracking — LONG", () => {
  test("EntryFilled fires on the first candle that touches entry", () => {
    const s = initialTrackingState({
      direction: "LONG",
      entry: 30_000,
      stopLoss: 29_500,
      takeProfit: [30_500, 31_000],
    });
    // Candle does NOT touch entry — no events.
    let evts = simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T12:00:00Z", o: 29_800, h: 29_900, l: 29_700, c: 29_850 }),
    );
    expect(evts).toEqual([]);
    expect(s.entryFilled).toBe(false);

    // Next candle's range spans entry → EntryFilled.
    evts = simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T13:00:00Z", o: 29_900, h: 30_100, l: 29_900, c: 30_050 }),
    );
    expect(evts).toHaveLength(1);
    expect(evts[0]?.kind).toBe("EntryFilled");
    expect(s.entryFilled).toBe(true);
  });

  test("TP1 hit moves SL to breakeven; final TP closes", () => {
    const s = initialTrackingState({
      direction: "LONG",
      entry: 30_000,
      stopLoss: 29_500,
      takeProfit: [30_500, 31_000],
    });
    // Fill on candle that touches entry but doesn't reach TP1.
    simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T12:00:00Z", o: 29_900, h: 30_100, l: 29_900, c: 30_050 }),
    );
    // Next candle hits TP1.
    let evts = simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T13:00:00Z", o: 30_100, h: 30_600, l: 30_050, c: 30_500 }),
    );
    expect(evts.map((e) => e.kind)).toEqual(["TPHit", "TrailingMoved"]);
    expect(s.currentSL).toBe(30_000);
    expect(s.nextTpIndex).toBe(1);
    expect(s.closed).toBe(false);
    // Final TP hits next candle → closed.
    evts = simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T14:00:00Z", o: 30_500, h: 31_100, l: 30_400, c: 31_000 }),
    );
    expect(evts).toHaveLength(1);
    expect(evts[0]?.kind).toBe("TPHit");
    if (evts[0]?.kind === "TPHit") {
      expect(evts[0].isFinal).toBe(true);
    }
    expect(s.closed).toBe(true);
    expect(closeReasonFromState(s)).toBe("all_tps_hit");
  });

  test("SL prioritaire intra-bougie : SL wins when same candle spans both SL and TP", () => {
    const s = initialTrackingState({
      direction: "LONG",
      entry: 30_000,
      stopLoss: 29_500,
      takeProfit: [30_500, 31_000],
    });
    // Fill first.
    simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T12:00:00Z", o: 29_900, h: 30_100, l: 29_900, c: 30_050 }),
    );
    // Whipsaw candle : low touches SL AND high touches TP1. SL wins.
    const evts = simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T13:00:00Z", o: 30_050, h: 30_600, l: 29_400, c: 29_600 }),
    );
    expect(evts.map((e) => e.kind)).toEqual(["SLHit"]);
    expect(s.closed).toBe(true);
    expect(closeReasonFromState(s)).toBe("sl_hit_direct");
  });

  test("SL hit after TP1 reports sl_hit_after_tp1", () => {
    const s = initialTrackingState({
      direction: "LONG",
      entry: 30_000,
      stopLoss: 29_500,
      takeProfit: [30_500, 31_000],
    });
    simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T12:00:00Z", o: 29_900, h: 30_100, l: 29_900, c: 30_050 }),
    );
    simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T13:00:00Z", o: 30_100, h: 30_600, l: 30_050, c: 30_500 }),
    );
    // After TP1, SL is now at entry = 30_000. Next candle low drops to 29_900.
    const evts = simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T14:00:00Z", o: 30_500, h: 30_600, l: 29_900, c: 29_950 }),
    );
    expect(evts).toHaveLength(1);
    expect(evts[0]?.kind).toBe("SLHit");
    expect(closeReasonFromState(s)).toBe("sl_hit_after_tp1");
  });

  test("post-close calls are no-ops", () => {
    const s = initialTrackingState({
      direction: "LONG",
      entry: 30_000,
      stopLoss: 29_500,
      takeProfit: [30_500],
    });
    simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T12:00:00Z", o: 29_900, h: 30_100, l: 29_900, c: 30_050 }),
    );
    simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T13:00:00Z", o: 30_100, h: 30_600, l: 30_050, c: 30_500 }),
    );
    expect(s.closed).toBe(true);
    const evts = simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T14:00:00Z", o: 30_500, h: 30_700, l: 30_400, c: 30_600 }),
    );
    expect(evts).toEqual([]);
  });
});

describe("simulateCandleTracking — SHORT", () => {
  test("SHORT happy path : entry then TP", () => {
    const s = initialTrackingState({
      direction: "SHORT",
      entry: 30_000,
      stopLoss: 30_500,
      takeProfit: [29_500, 29_000],
    });
    simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T12:00:00Z", o: 30_100, h: 30_100, l: 29_900, c: 29_950 }),
    );
    expect(s.entryFilled).toBe(true);
    const evts = simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T13:00:00Z", o: 29_950, h: 30_000, l: 29_400, c: 29_500 }),
    );
    expect(evts.map((e) => e.kind)).toEqual(["TPHit", "TrailingMoved"]);
    expect(s.currentSL).toBe(30_000);
  });

  test("SHORT SL hit", () => {
    const s = initialTrackingState({
      direction: "SHORT",
      entry: 30_000,
      stopLoss: 30_500,
      takeProfit: [29_500],
    });
    simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T12:00:00Z", o: 30_100, h: 30_100, l: 29_900, c: 29_950 }),
    );
    const evts = simulateCandleTracking(
      s,
      candle({ ts: "2026-04-29T13:00:00Z", o: 29_950, h: 30_600, l: 29_900, c: 30_550 }),
    );
    expect(evts.map((e) => e.kind)).toEqual(["SLHit"]);
    expect(closeReasonFromState(s)).toBe("sl_hit_direct");
  });
});
