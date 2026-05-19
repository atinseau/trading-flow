import type { Candle } from "@domain/schemas/Candle";
import { detectSwings } from "../base/math";

export type FibonacciParams = { lookback: number };
export const FIBONACCI_DEFAULT_PARAMS: FibonacciParams = { lookback: 3 };

export type FibAnchor = {
  high: number;
  low: number;
  highIdx: number;
  lowIdx: number;
  direction: "uptrend" | "downtrend";
};

export type FibLevels = {
  fib_0_382: number;
  fib_0_500: number;
  fib_0_618: number;
  fib_1_272: number;
  fib_1_618: number;
};

function readLookback(params?: Record<string, unknown>): number {
  const lb = params?.lookback;
  return typeof lb === "number" ? lb : FIBONACCI_DEFAULT_PARAMS.lookback;
}

/** Picks the most recent confirmed swing PAIR (one high + one low). Direction
 *  is determined by which came LAST (closer to the right edge — that's the
 *  active impulse leg the trader cares about). Returns null if fewer than
 *  one of each kind exists. */
export function computeAnchor(highs: number[], lows: number[], lookback: number): FibAnchor | null {
  const swings = detectSwings(highs, lows, lookback);
  const lastHighIdx = swings.highs[swings.highs.length - 1];
  const lastLowIdx = swings.lows[swings.lows.length - 1];
  if (lastHighIdx == null || lastLowIdx == null) return null;
  const high = highs[lastHighIdx];
  const low = lows[lastLowIdx];
  if (high == null || low == null) return null;
  const direction: FibAnchor["direction"] = lastLowIdx < lastHighIdx ? "uptrend" : "downtrend";
  return { high, low, highIdx: lastHighIdx, lowIdx: lastLowIdx, direction };
}

export function fibLevels(anchor: FibAnchor): FibLevels {
  const range = anchor.high - anchor.low;
  if (anchor.direction === "uptrend") {
    return {
      fib_0_382: anchor.high - range * 0.382,
      fib_0_500: anchor.high - range * 0.5,
      fib_0_618: anchor.high - range * 0.618,
      fib_1_272: anchor.high + range * 0.272,
      fib_1_618: anchor.high + range * 0.618,
    };
  }
  // downtrend
  return {
    fib_0_382: anchor.low + range * 0.382,
    fib_0_500: anchor.low + range * 0.5,
    fib_0_618: anchor.low + range * 0.618,
    fib_1_272: anchor.low - range * 0.272,
    fib_1_618: anchor.low - range * 0.618,
  };
}

export function computeScalars(candles: Candle[], params?: Record<string, unknown>) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const anchor = computeAnchor(highs, lows, readLookback(params));
  if (!anchor) {
    return {
      fibAnchorHigh: null,
      fibAnchorLow: null,
      fibDirection: null,
      fib_0_382: null,
      fib_0_500: null,
      fib_0_618: null,
      fib_1_272: null,
      fib_1_618: null,
    };
  }
  const lv = fibLevels(anchor);
  return {
    fibAnchorHigh: anchor.high,
    fibAnchorLow: anchor.low,
    fibDirection: anchor.direction,
    ...lv,
  };
}
