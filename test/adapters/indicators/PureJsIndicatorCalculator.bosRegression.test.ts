import { describe, expect, test } from "bun:test";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";

const calc = new PureJsIndicatorCalculator();

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
    const ind = await calc.compute(candles);
    expect(ind.bosState).toBe("bullish");
  });

  test("Bearish BOS: decisive break below last swing low", async () => {
    // Mirror of the bullish case.
    const candles = flatSeries(250, 100);
    candles[50] = troughCandle(50, 90);
    for (let k = 0; k < 145; k++) {
      candles[100 + k] = breachCandle(100 + k, 95 - k * 0.3);
    }
    const ind = await calc.compute(candles);
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
    const ind = await calc.compute(candles);
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
    const ind = await calc.compute(candles);
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

describe("PureJsIndicatorCalculator — equalPivots (anchored cluster reference)", () => {
  /**
   * Build a 250-bar series with three swing highs at the given prices placed
   * at the given indices. Indices must be ≥2 apart, ≥2 from start, and
   * ≤n-3 from end (boundary check). All other bars are flat at `base`.
   */
  function seriesWithHighs(prices: number[], indices: number[], base = 100): Candle[] {
    const candles = flatSeries(250, base);
    for (let k = 0; k < prices.length; k++) {
      const i = indices[k];
      const p = prices[k];
      if (i === undefined || p === undefined) continue;
      candles[i] = peakCandle(i, p);
    }
    return candles;
  }

  test("Order-independent clustering: same prices in different order produce same cluster count (regression)", async () => {
    // Regression for the equalPivots refactor. The OLD rolling-mean reference
    // made clustering order-dependent: walking pivots in price-order
    // [110.00, 110.10, 110.20] cluster together (each step is within 0.1%
    // of the running mean), but encountering them in [110.00, 110.20, 110.10]
    // splits — at step 2 the mean is 110.00, |110.20 - 110.00|/110.00 =
    // 0.18% > 0.1%, so 110.20 starts a new cluster. The anchored
    // implementation pins the reference to the FIRST pivot's price, so
    // membership only depends on each candidate's distance from that anchor —
    // a constant, independent of insertion order.
    //
    // We can't directly control pivot iteration order (it's always
    // ascending by index), but we CAN control the price the calculator sees
    // at each pivot index. Place peaks at indices 210, 225, 240 — the
    // calculator iterates in this index order. Series A has prices
    // [110.00, 110.10, 110.20] at those indices; series B has
    // [110.00, 110.20, 110.10]. Same set of prices, same set of indices,
    // different ORDER through the equalPivots loop.
    const seriesA = seriesWithHighs([110.0, 110.1, 110.2], [210, 225, 240]);
    const seriesB = seriesWithHighs([110.0, 110.2, 110.1], [210, 225, 240]);

    const indA = await calc.compute(seriesA);
    const indB = await calc.compute(seriesB);

    // Anchored implementation: both A and B form ONE cluster of 3 pivots
    // (each pivot is within 0.1%×110 ≈ 0.11 of the anchor at 110.00 — wait,
    // 110.20 is 0.18% from 110.00 which EXCEEDS tolerance). So in fact the
    // anchored impl also splits 110.00 from 110.20. The order-independence
    // claim is that the SAME split happens regardless of which order the
    // 110.10 / 110.20 pivots are seen — both A and B should produce the
    // same cluster structure.
    expect(indA.topEqualHighs.length).toBe(indB.topEqualHighs.length);
    expect(indA.equalHighsCount).toBe(indB.equalHighsCount);
    // The reported cluster price (mean of members) must also be identical
    // across orderings — the anchored impl computes it from the same set of
    // member prices regardless of insertion order.
    const priceA = indA.topEqualHighs[0]?.price;
    const priceB = indB.topEqualHighs[0]?.price;
    expect(priceA).toBeDefined();
    expect(priceB).toBeDefined();
    if (priceA !== undefined && priceB !== undefined) {
      expect(priceA).toBeCloseTo(priceB, 4);
    }
  });

  test("Cluster reported price is the mean of its members", async () => {
    // Three peaks at 110.00, 110.05, 110.10 (max spread 0.045%, all within
    // 0.1% of the 110.00 anchor). They should form a single cluster, and
    // the reported `price` is the mean = (110.00 + 110.05 + 110.10) / 3
    // ≈ 110.05.
    const candles = seriesWithHighs([110.0, 110.05, 110.1], [210, 225, 240]);
    const ind = await calc.compute(candles);
    expect(ind.topEqualHighs.length).toBeGreaterThanOrEqual(1);
    const cluster = ind.topEqualHighs[0];
    expect(cluster).toBeDefined();
    if (!cluster) return;
    expect(cluster.touches).toBe(3);
    expect(cluster.price).toBeCloseTo(110.05, 2);
  });

  test("Tolerance boundary: pivots at 0.1% apart cluster, at 0.15% apart split", async () => {
    // Within tolerance: 110.00 and 110.10 are 0.0909...% apart (< 0.1%) →
    // single cluster of 2.
    const within = seriesWithHighs([110.0, 110.1], [220, 240]);
    const indWithin = await calc.compute(within);
    expect(indWithin.topEqualHighs.length).toBe(1);
    expect(indWithin.topEqualHighs[0]?.touches).toBe(2);

    // Outside tolerance: 110.00 and 110.165 are 0.15% apart → two singletons,
    // neither of which qualifies as a cluster (need ≥2 hits).
    const outside = seriesWithHighs([110.0, 110.165], [220, 240]);
    const indOutside = await calc.compute(outside);
    expect(indOutside.topEqualHighs.length).toBe(0);
  });

  test("Single pivot does not form a cluster (need ≥2 hits)", async () => {
    // One swing high at idx 230 — no second pivot within tolerance, so
    // topEqualHighs is empty.
    const candles = seriesWithHighs([110.0], [230]);
    const ind = await calc.compute(candles);
    expect(ind.topEqualHighs.length).toBe(0);
    expect(ind.equalHighsCount).toBe(0);
  });
});
