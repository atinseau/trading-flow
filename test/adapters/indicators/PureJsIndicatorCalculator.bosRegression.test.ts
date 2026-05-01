import { describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";

const calc = new PureJsIndicatorCalculator();
const registry = new IndicatorRegistry();
// Use swings_bos plugin for BOS-related scalar tests
const swingsBosPlugin = registry.resolveActive({ swings_bos: { enabled: true } });

type BosInd = {
  bosState?: string;
  topEqualHighs?: Array<{ price: number; touches: number }>;
  topEqualLows?: Array<{ price: number; touches: number }>;
};

/**
 * Build a flat candle (used as the "background" of a synthetic series).
 * Range is 0.5 around `price` so it's wider than fractal noise but small
 * enough not to accidentally become a swing peak.
 */
function flatCandle(i: number, price: number): Candle {
  return {
    timestamp: new Date(i * 900_000),
    open: price,
    high: price + 0.5,
    low: price - 0.5,
    close: price,
    volume: 100,
  };
}

/**
 * Build a single-bar peak candle. The peak is `peakHigh` and the body sits
 * above the surrounding flat baseline so swing-high detection (lookback=2)
 * fires at this index. Caller must ensure neighbours are flat at a lower price.
 *
 * NOTE: `body` defaults to 100 to match `flatCandle`'s default baseline (100).
 * If callers use a different `basePrice` in `flatSeries`, they must pass a
 * matching `body` here, otherwise the body will be off-baseline and may
 * accidentally form a fractal pattern with neighbours.
 */
function peakCandle(i: number, peakHigh: number, body = 100): Candle {
  return {
    timestamp: new Date(i * 900_000),
    open: body,
    high: peakHigh,
    low: body - 0.5,
    close: body,
    volume: 100,
  };
}

/**
 * Mirror of peakCandle for swing lows. Same `body=100` coupling to the flat
 * baseline applies — caller must keep them consistent.
 */
function troughCandle(i: number, troughLow: number, body = 100): Candle {
  return {
    timestamp: new Date(i * 900_000),
    open: body,
    high: body + 0.5,
    low: troughLow,
    close: body,
    volume: 100,
  };
}

/**
 * Build a 250-bar series where every candle is `flatCandle(i, basePrice)`.
 * Callers then overwrite specific indices to inject peaks/troughs/breaches.
 */
function flatSeries(n: number, basePrice: number): Candle[] {
  return Array.from({ length: n }, (_, i) => flatCandle(i, basePrice));
}

/**
 * Inject a closing breach at index `idx` — a candle whose CLOSE clears
 * `targetClose` (above for bullish, below for bearish). The candle's high/low
 * are set so it does NOT itself form a fractal peak vs. its neighbours
 * (otherwise it could become the "latest" swing and shift bookkeeping).
 */
function breachCandle(i: number, closePrice: number): Candle {
  return {
    timestamp: new Date(i * 900_000),
    open: closePrice,
    high: closePrice + 0.2,
    low: closePrice - 0.2,
    close: closePrice,
    volume: 100,
  };
}

describe("PureJsIndicatorCalculator — detectBosState (max-index across all swings)", () => {
  test("Bullish BOS: clear breakout above last swing high", async () => {
    // Flat baseline at 100, single swing high at idx 50 reaching 110, then
    // a strong run-up after idx 100 that closes well above 110.
    const candles = flatSeries(250, 100);
    candles[50] = peakCandle(50, 110);
    // Closes 105..145 starting at idx 100 — all above the swing high (110)
    // from idx ~105 onward. Stops 2 bars before end so the breach itself
    // never becomes a swing high.
    for (let k = 0; k < 145; k++) {
      candles[100 + k] = breachCandle(100 + k, 105 + k);
    }
    const ind = await calc.compute(candles, swingsBosPlugin) as BosInd;
    expect(ind.bosState).toBe("bullish");
  });

  test("Bearish BOS: decisive break below last swing low", async () => {
    // Mirror of the bullish case.
    const candles = flatSeries(250, 100);
    candles[50] = troughCandle(50, 90);
    for (let k = 0; k < 145; k++) {
      candles[100 + k] = breachCandle(100 + k, 95 - k * 0.3);
    }
    const ind = await calc.compute(candles, swingsBosPlugin) as BosInd;
    expect(ind.bosState).toBe("bearish");
  });

  test("No BOS: ranging market with swings present but no breach", async () => {
    // Flat baseline at 100 with small peaks at 100.5 (swing highs) and
    // small troughs at 99.5 (swing lows), but no candle ever closes outside
    // the [99.5, 100.5] envelope.
    const candles = flatSeries(250, 100);
    // Place a swing high at idx 60 (peak 101) and a swing low at idx 120
    // (trough 99). No subsequent close ever exceeds 101 or drops below 99.
    candles[60] = peakCandle(60, 101);
    candles[120] = troughCandle(120, 99);
    const ind = await calc.compute(candles, swingsBosPlugin) as BosInd;
    expect(ind.bosState).toBe("none");
  });

  test("Most-recent breach wins: bearish at idx 200 beats bullish at idx 80 (regression)", async () => {
    // Regression for the bug fixed in detectBosState: the OLD implementation
    // walked swings newest-to-oldest and broke at the first breached swing,
    // so an OLDER swing breached more RECENTLY against an opposite-direction
    // swing would be ignored. Here:
    //   - OLD swing HIGH at idx 30 (110), breached bullish at idx 80.
    //   - NEW swing LOW at idx 100 (90), breached bearish at idx 200.
    // The bearish breach (idx 200) is more recent than the bullish breach
    // (idx 80), so the refactored logic must return "bearish".
    // The OLD code, scanning newest-swing-first, would hit the swing low at
    // idx 100, find it breached at idx 200 → return bearish. To force the
    // OLD bug we instead need the bullish swing to be the NEWEST swing but
    // the bearish breach to be more recent. Rearrange:
    //   - NEW swing HIGH at idx 100 (110), breached bullish at idx 130.
    //   - OLD swing LOW at idx 30 (90), breached bearish at idx 200.
    // OLD code: walks newest swing-high (idx 100), finds it breached at
    // idx 130, returns "bullish" immediately. NEW code: scans both, sees
    // bearish breach at idx 200 > bullish at idx 130 → returns "bearish".
    //
    // Candle layout — only TWO swings exist (idx 30 trough, idx 100 peak).
    // The breach windows below use 3-bar plateaus at the breach price, with
    // the bars immediately around the plateau left flat. This prevents the
    // breach itself from forming a new fractal peak/trough: the plateau bars
    // share equal extrema (so the lookback=2 strict-inequality check fails),
    // and the surrounding flat bars don't create a left/right pattern either.
    const candles = flatSeries(250, 100);
    candles[30] = troughCandle(30, 90); // OLD swing low
    candles[100] = peakCandle(100, 110); // NEW swing high
    // Bullish breach at idx 130 (close > 110). 3-bar plateau at 111 so no
    // bar in [130, 131, 132] is a fractal high (each has an equal-high
    // neighbour, breaking the strict-inequality check).
    candles[130] = breachCandle(130, 111);
    candles[131] = breachCandle(131, 111);
    candles[132] = breachCandle(132, 111);
    // Bearish breach at idx 200 (close < 90). Same 3-bar plateau trick.
    candles[200] = breachCandle(200, 89);
    candles[201] = breachCandle(201, 89);
    candles[202] = breachCandle(202, 89);
    const ind = await calc.compute(candles, swingsBosPlugin) as BosInd;
    expect(ind.bosState).toBe("bearish");
  });

  // NOTE: A "multiple bullish breaches: latest wins" test was considered here
  // but deleted as redundant. With swing-highs-only scenarios, both the OLD
  // newest-first code and the NEW max-index code return "bullish" — they
  // only differ in WHICH breach index they internally pick, and that index
  // isn't part of the public API. The cross-direction regression in the
  // previous test ("most-recent breach wins") already covers the max-index
  // semantics by flipping the verdict between OLD and NEW.
});

// NOTE: "equalPivots (anchored cluster reference)" tests are ported to
// test/adapters/indicators/plugins/liquidity_pools/index.test.ts
// (topEqualHighs / equalHighsCount are owned by the liquidity_pools plugin, not swings_bos).
