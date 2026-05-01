import type { IndicatorCalculator, IndicatorSeries } from "@domain/ports/IndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";
import type { Indicators } from "@domain/schemas/Indicators";
import { IndicatorsSchema } from "@domain/schemas/Indicators";

/** Distance (pct) within which two pivot prices count as "equal". */
const EQUAL_PIVOT_TOLERANCE_PCT = 0.001;

/** Look-back/forward (in candles) for the swing-pivot detection (3-bar fractal). */
const SWING_LOOKBACK = 2;

/** How many candles back to look at when detecting recent equal H/L and POC. */
const RECENT_WINDOW = 50;

/** Volume-profile bucket count for POC approximation. */
const POC_BUCKETS = 30;

export class PureJsIndicatorCalculator implements IndicatorCalculator {
  async compute(candles: Candle[]): Promise<Indicators> {
    if (candles.length < 200) {
      throw new Error(`Need ≥200 candles for ema200, got ${candles.length}`);
    }
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const atrSeries = this.atrSeries(highs, lows, closes, 14);
    const atrLast = atrSeries[atrSeries.length - 1] ?? 0;
    const atrMa20 = this.movingAverage(atrSeries, 20);
    const atrZScore200 = this.zScoreOfLast(atrSeries, 200);

    const ema20 = this.ema(closes, 20);
    const ema50 = this.ema(closes, 50);
    const ema200 = this.ema(closes, 200);

    const vwapValues = this.vwapSeries(candles);
    const vwapLast = vwapValues[vwapValues.length - 1] ?? closes[closes.length - 1] ?? 0;
    const lastClose = closes[closes.length - 1] ?? 0;
    const priceVsVwapPct = vwapLast === 0 ? 0 : ((lastClose - vwapLast) / vwapLast) * 100;

    const bb = this.bollingerLast(closes, 20, 2);
    // Per-asset BB bandwidth percentile vs last 200 candles. Replaces the
    // hard "< 4%" threshold which fits majors but not BTC.
    const bbBands200 = this.bollingerSeriesAligned(closes, 20, 2);
    const bandwidth200: number[] = [];
    for (let i = 0; i < bbBands200.middle.length; i++) {
      const m = bbBands200.middle[i];
      const u = bbBands200.upper[i];
      const l = bbBands200.lower[i];
      if (m == null || u == null || l == null || m === 0) continue;
      bandwidth200.push(((u - l) / m) * 100);
    }
    const bandwidthCurrent = bb.middle === 0 ? 0 : ((bb.upper - bb.lower) / bb.middle) * 100;
    // Percentile sample EXCLUDES the current bar — otherwise the metric
    // includes itself and an all-time-low bandwidth can never report 0.
    const bbBandwidthPercentile200 = this.percentileOf(
      bandwidthCurrent,
      bandwidth200.slice(-201, -1),
    );
    const volumePercentile200 = this.percentileOf(
      volumes[volumes.length - 1] ?? 0,
      volumes.slice(-201, -1),
    );

    const macd = this.macdLast(closes, 12, 26, 9);

    const swings = this.detectSwings(highs, lows, SWING_LOOKBACK);
    const lastSwingHighIdx = swings.highs.length > 0 ? swings.highs[swings.highs.length - 1] : null;
    const lastSwingLowIdx = swings.lows.length > 0 ? swings.lows[swings.lows.length - 1] : null;
    const lastIdx = candles.length - 1;

    const bosState = this.detectBosState(highs, lows, closes, swings);

    const pocPrice = this.pointOfControl(candles.slice(-RECENT_WINDOW), POC_BUCKETS);

    const recentEqualH = this.equalPivots(
      swings.highs.filter((i) => i >= candles.length - RECENT_WINDOW),
      highs,
      EQUAL_PIVOT_TOLERANCE_PCT,
    );
    const recentEqualL = this.equalPivots(
      swings.lows.filter((i) => i >= candles.length - RECENT_WINDOW),
      lows,
      EQUAL_PIVOT_TOLERANCE_PCT,
    );

    return IndicatorsSchema.parse({
      rsi: this.rsi(closes, 14),
      ema20,
      ema50,
      ema200,
      atr: atrLast,
      atrMa20,
      atrZScore200,
      volumeMa20: this.movingAverage(volumes, 20),
      lastVolume: volumes[volumes.length - 1] ?? 0,
      recentHigh: Math.max(...highs.slice(-50)),
      recentLow: Math.min(...lows.slice(-50)),
      vwapSession: vwapLast,
      priceVsVwapPct,
      bbUpper: bb.upper,
      bbMiddle: bb.middle,
      bbLower: bb.lower,
      bbBandwidthPct: bandwidthCurrent,
      bbBandwidthPercentile200,
      volumePercentile200,
      macd: macd.macd,
      macdSignal: macd.signal,
      macdHist: macd.hist,
      lastSwingHigh: lastSwingHighIdx == null ? null : (highs[lastSwingHighIdx] ?? null),
      lastSwingHighAge: lastSwingHighIdx == null ? null : lastIdx - lastSwingHighIdx,
      lastSwingLow: lastSwingLowIdx == null ? null : (lows[lastSwingLowIdx] ?? null),
      lastSwingLowAge: lastSwingLowIdx == null ? null : lastIdx - lastSwingLowIdx,
      bosState,
      pocPrice,
      equalHighsCount: recentEqualH.reduce((a, b) => a + b.indices.length, 0),
      equalLowsCount: recentEqualL.reduce((a, b) => a + b.indices.length, 0),
      topEqualHighs: recentEqualH
        .map((g) => ({ price: g.price, touches: g.indices.length }))
        .sort((a, b) => b.touches - a.touches)
        .slice(0, 3),
      topEqualLows: recentEqualL
        .map((g) => ({ price: g.price, touches: g.indices.length }))
        .sort((a, b) => b.touches - a.touches)
        .slice(0, 3),
    });
  }

  async computeSeries(candles: Candle[]): Promise<IndicatorSeries> {
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);
    const n = candles.length;

    const ema20 = this.emaSeriesAligned(closes, 20, n);
    const ema50 = this.emaSeriesAligned(closes, 50, n);
    const ema200 = this.emaSeriesAligned(closes, 200, n);
    const rsi = this.rsiSeriesAligned(closes, 14, n);

    const atrCore = this.atrSeries(highs, lows, closes, 14);
    const atrPadLen = n - atrCore.length;
    const atr: (number | null)[] = [
      ...Array.from({ length: atrPadLen }, (): number | null => null),
      ...atrCore,
    ];
    const atrMa20 = this.rollingMaAligned(atr, 20);
    const volumeMa20 = this.rollingMaAligned(
      volumes.map((v) => v as number | null),
      20,
    );

    const vwap = this.vwapSeriesAligned(candles);
    const bbBands = this.bollingerSeriesAligned(closes, 20, 2);
    const macd = this.macdSeriesAligned(closes, 12, 26, 9);

    const swings = this.detectSwings(highs, lows, SWING_LOOKBACK);
    const swingHighs = swings.highs.map((i) => ({ index: i, price: highs[i] as number }));
    const swingLows = swings.lows.map((i) => ({ index: i, price: lows[i] as number }));

    const fvgs = this.detectFvgs(candles);

    const equalHighs = this.equalPivots(swings.highs, highs, EQUAL_PIVOT_TOLERANCE_PCT);
    const equalLows = this.equalPivots(swings.lows, lows, EQUAL_PIVOT_TOLERANCE_PCT);

    return {
      ema20,
      ema50,
      ema200,
      vwap,
      bbUpper: bbBands.upper,
      bbMiddle: bbBands.middle,
      bbLower: bbBands.lower,
      rsi,
      atr,
      atrMa20,
      volumeMa20,
      macd: macd.macd,
      macdSignal: macd.signal,
      macdHist: macd.hist,
      swingHighs,
      swingLows,
      fvgs,
      equalHighs,
      equalLows,
    };
  }

  // ─── Momentum ─────────────────────────────────────────────────────────────

  private rsi(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const cur = closes[i];
      const prev = closes[i - 1];
      if (cur === undefined || prev === undefined) continue;
      const diff = cur - prev;
      if (diff > 0) avgGain += diff;
      else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;
    for (let i = period + 1; i < closes.length; i++) {
      const cur = closes[i];
      const prev = closes[i - 1];
      if (cur === undefined || prev === undefined) continue;
      const diff = cur - prev;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private rsiSeriesAligned(closes: number[], period: number, n: number): (number | null)[] {
    const out: (number | null)[] = Array.from({ length: n }, () => null);
    if (closes.length < period + 1) return out;
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const cur = closes[i];
      const prev = closes[i - 1];
      if (cur === undefined || prev === undefined) continue;
      const diff = cur - prev;
      if (diff > 0) avgGain += diff;
      else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < closes.length; i++) {
      const cur = closes[i];
      const prev = closes[i - 1];
      if (cur === undefined || prev === undefined) continue;
      const diff = cur - prev;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  // ─── EMA ──────────────────────────────────────────────────────────────────

  private ema(values: number[], period: number): number {
    if (values.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) {
      const v = values[i];
      if (v === undefined) continue;
      ema = v * k + ema * (1 - k);
    }
    return ema;
  }

  private emaSeriesAligned(values: number[], period: number, n: number): (number | null)[] {
    const out: (number | null)[] = Array.from({ length: n }, () => null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period - 1] = ema;
    for (let i = period; i < values.length; i++) {
      const v = values[i];
      if (v === undefined) continue;
      ema = v * k + ema * (1 - k);
      out[i] = ema;
    }
    return out;
  }

  // ─── ATR + Z-score ────────────────────────────────────────────────────────

  private atrSeries(highs: number[], lows: number[], closes: number[], period: number): number[] {
    const trs: number[] = [];
    for (let i = 1; i < highs.length; i++) {
      const h = highs[i];
      const l = lows[i];
      const cPrev = closes[i - 1];
      if (h === undefined || l === undefined || cPrev === undefined) continue;
      const tr = Math.max(h - l, Math.abs(h - cPrev), Math.abs(l - cPrev));
      trs.push(tr);
    }
    const out: number[] = [];
    if (trs.length < period) return out;
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out.push(atr);
    for (let i = period; i < trs.length; i++) {
      const tr = trs[i];
      if (tr === undefined) continue;
      atr = (atr * (period - 1) + tr) / period;
      out.push(atr);
    }
    return out;
  }

  private zScoreOfLast(series: number[], window: number): number {
    if (series.length < 2) return 0;
    const sample = series.slice(-window);
    const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
    const variance =
      sample.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(sample.length - 1, 1);
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    const last = series[series.length - 1];
    return last === undefined ? 0 : (last - mean) / std;
  }

  // ─── VWAP (session) ───────────────────────────────────────────────────────
  // Anchored at the most recent UTC midnight crossed by the candle range.
  // For continuous markets like crypto this corresponds to the trading day;
  // for stocks the session boundary may need a different anchor — fine for v1.

  private vwapSeries(candles: Candle[]): number[] {
    const aligned = this.vwapSeriesAligned(candles);
    return aligned.filter((v): v is number => v !== null);
  }

  private vwapSeriesAligned(candles: Candle[]): (number | null)[] {
    const out: (number | null)[] = candles.map(() => null);
    if (candles.length === 0) return out;

    let anchorDay = -1;
    let cumPV = 0;
    let cumV = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (c === undefined) continue;
      const day = Math.floor(c.timestamp.getTime() / 86_400_000);
      if (day !== anchorDay) {
        anchorDay = day;
        cumPV = 0;
        cumV = 0;
      }
      const typical = (c.high + c.low + c.close) / 3;
      cumPV += typical * c.volume;
      cumV += c.volume;
      out[i] = cumV === 0 ? typical : cumPV / cumV;
    }
    return out;
  }

  // ─── Bollinger Bands ──────────────────────────────────────────────────────

  private bollingerLast(
    closes: number[],
    period: number,
    stdMul: number,
  ): { upper: number; middle: number; lower: number } {
    if (closes.length < period) {
      const v = closes[closes.length - 1] ?? 0;
      return { upper: v, middle: v, lower: v };
    }
    const slice = closes.slice(-period);
    const middle = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((acc, v) => acc + (v - middle) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    return { upper: middle + std * stdMul, middle, lower: middle - std * stdMul };
  }

  private bollingerSeriesAligned(
    closes: number[],
    period: number,
    stdMul: number,
  ): {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
  } {
    const upper: (number | null)[] = closes.map(() => null);
    const middle: (number | null)[] = closes.map(() => null);
    const lower: (number | null)[] = closes.map(() => null);
    for (let i = period - 1; i < closes.length; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const m = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((acc, v) => acc + (v - m) ** 2, 0) / period;
      const std = Math.sqrt(variance);
      upper[i] = m + std * stdMul;
      middle[i] = m;
      lower[i] = m - std * stdMul;
    }
    return { upper, middle, lower };
  }

  // ─── MACD ─────────────────────────────────────────────────────────────────

  private macdLast(
    closes: number[],
    fast: number,
    slow: number,
    signal: number,
  ): { macd: number; signal: number; hist: number } {
    const macdSeries = this.macdSeriesAligned(closes, fast, slow, signal);
    const last = (arr: (number | null)[]) => arr[arr.length - 1] ?? 0;
    return {
      macd: last(macdSeries.macd),
      signal: last(macdSeries.signal),
      hist: last(macdSeries.hist),
    };
  }

  private macdSeriesAligned(
    closes: number[],
    fast: number,
    slow: number,
    signalPeriod: number,
  ): {
    macd: (number | null)[];
    signal: (number | null)[];
    hist: (number | null)[];
  } {
    const n = closes.length;
    const fastEma = this.emaSeriesAligned(closes, fast, n);
    const slowEma = this.emaSeriesAligned(closes, slow, n);
    const macd: (number | null)[] = closes.map((_, i) => {
      const f = fastEma[i];
      const s = slowEma[i];
      return f == null || s == null ? null : f - s;
    });
    // Signal = EMA of the macd line (only over its non-null values).
    const macdValues = macd.map((v) => (v == null ? 0 : v));
    const signalSeries = this.emaSeriesAligned(macdValues, signalPeriod, n);
    // Mask leading positions where macd was null (signal is meaningless there).
    const signal: (number | null)[] = signalSeries.map((v, i) => (macd[i] == null ? null : v));
    const hist: (number | null)[] = macd.map((m, i) => {
      const sg = signal[i];
      return m == null || sg == null ? null : m - sg;
    });
    return { macd, signal, hist };
  }

  // ─── Swing detection (3-bar fractal, parameterizable lookback) ────────────

  private detectSwings(
    highs: number[],
    lows: number[],
    lookback: number,
  ): { highs: number[]; lows: number[] } {
    const swingHighs: number[] = [];
    const swingLows: number[] = [];
    for (let i = lookback; i < highs.length - lookback; i++) {
      const h = highs[i];
      const l = lows[i];
      if (h === undefined || l === undefined) continue;
      let isHigh = true;
      let isLow = true;
      for (let j = 1; j <= lookback; j++) {
        const left = highs[i - j];
        const right = highs[i + j];
        if (left === undefined || right === undefined || left >= h || right >= h) {
          isHigh = false;
          break;
        }
      }
      for (let j = 1; j <= lookback; j++) {
        const left = lows[i - j];
        const right = lows[i + j];
        if (left === undefined || right === undefined || left <= l || right <= l) {
          isLow = false;
          break;
        }
      }
      if (isHigh) swingHighs.push(i);
      if (isLow) swingLows.push(i);
    }
    return { highs: swingHighs, lows: swingLows };
  }

  // ─── Break of Structure state ─────────────────────────────────────────────
  // Bullish BOS: latest close > previous swing high. Bearish: latest close <
  // previous swing low. Take whichever happened more recently.

  private detectBosState(
    highs: number[],
    lows: number[],
    closes: number[],
    swings: { highs: number[]; lows: number[] },
  ): "bullish" | "bearish" | "none" {
    if (closes[closes.length - 1] === undefined) return "none";
    // Scan ALL swings, find the breach (close-beyond-swing) with the maximum
    // close-index. The previous implementation walked swings newest-to-oldest
    // and broke at the first one breached, which can hide a more recent
    // breach if it occurred against a less-recent swing. Cost is O(n) total
    // with early `break` on first matching close per swing.
    let bullishAt = -1;
    let bearishAt = -1;
    for (const idx of swings.highs) {
      const swingPrice = highs[idx];
      if (swingPrice === undefined) continue;
      for (let j = idx + 1; j < closes.length; j++) {
        const c = closes[j];
        if (c !== undefined && c > swingPrice) {
          if (j > bullishAt) bullishAt = j;
          break;
        }
      }
    }
    for (const idx of swings.lows) {
      const swingPrice = lows[idx];
      if (swingPrice === undefined) continue;
      for (let j = idx + 1; j < closes.length; j++) {
        const c = closes[j];
        if (c !== undefined && c < swingPrice) {
          if (j > bearishAt) bearishAt = j;
          break;
        }
      }
    }
    if (bullishAt === -1 && bearishAt === -1) return "none";
    return bullishAt > bearishAt ? "bullish" : "bearish";
  }

  // ─── Fair Value Gap (3-bar imbalance) ─────────────────────────────────────

  private detectFvgs(
    candles: Candle[],
  ): { index: number; top: number; bottom: number; direction: "bullish" | "bearish" }[] {
    const out: { index: number; top: number; bottom: number; direction: "bullish" | "bearish" }[] =
      [];
    for (let i = 1; i < candles.length - 1; i++) {
      const a = candles[i - 1];
      const b = candles[i];
      const c = candles[i + 1];
      if (a === undefined || b === undefined || c === undefined) continue;
      // Bullish FVG: candle c's low > candle a's high (gap above).
      if (c.low > a.high) {
        out.push({ index: i, top: c.low, bottom: a.high, direction: "bullish" });
      }
      // Bearish FVG: candle c's high < candle a's low (gap below).
      else if (c.high < a.low) {
        out.push({ index: i, top: a.low, bottom: c.high, direction: "bearish" });
      }
    }
    return out;
  }

  // ─── Equal pivots (liquidity pools) ───────────────────────────────────────

  private equalPivots(
    pivotIndices: number[],
    prices: number[],
    tolerancePct: number,
  ): { price: number; indices: number[] }[] {
    // Anchor each cluster on its FIRST pivot's price so clustering is
    // order-independent. The previous rolling-mean reference made
    // [100, 100.1, 100.2] cluster but [100, 100.2, 100.1] split — same data,
    // different output. Anchored reference is stable; the reported `price`
    // becomes the mean of all members at the end (representative without
    // affecting membership decisions).
    const groups: { anchor: number; indices: number[] }[] = [];
    for (const idx of pivotIndices) {
      const p = prices[idx];
      if (p === undefined) continue;
      const existing = groups.find((g) => Math.abs(g.anchor - p) / g.anchor <= tolerancePct);
      if (existing) {
        existing.indices.push(idx);
      } else {
        groups.push({ anchor: p, indices: [idx] });
      }
    }
    // ≥ 2 hits = a real pool; report the mean price of the cluster as the
    // representative level (more useful for charting than the anchor).
    return groups
      .filter((g) => g.indices.length >= 2)
      .map((g) => ({
        price: g.indices.reduce((sum, i) => sum + (prices[i] ?? g.anchor), 0) / g.indices.length,
        indices: g.indices,
      }));
  }

  // ─── Point of Control (volume profile, simplified) ────────────────────────

  private pointOfControl(candles: Candle[], buckets: number): number {
    if (candles.length === 0) return 0;
    const min = Math.min(...candles.map((c) => c.low));
    const max = Math.max(...candles.map((c) => c.high));
    if (min === max) return min;
    const step = (max - min) / buckets;
    const volByBucket = Array.from({ length: buckets }, () => 0);
    for (const c of candles) {
      const startBucket = Math.min(buckets - 1, Math.max(0, Math.floor((c.low - min) / step)));
      const endBucket = Math.min(buckets - 1, Math.max(0, Math.floor((c.high - min) / step)));
      const span = endBucket - startBucket + 1;
      const slice = c.volume / span;
      for (let b = startBucket; b <= endBucket; b++) {
        volByBucket[b] = (volByBucket[b] ?? 0) + slice;
      }
    }
    let bestBucket = 0;
    let bestVol = -1;
    for (let b = 0; b < buckets; b++) {
      const v = volByBucket[b] ?? 0;
      if (v > bestVol) {
        bestVol = v;
        bestBucket = b;
      }
    }
    return min + (bestBucket + 0.5) * step;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private rollingMaAligned(values: (number | null)[], period: number): (number | null)[] {
    const out: (number | null)[] = values.map(() => null);
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0;
      let count = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const v = values[j];
        if (v == null) continue;
        sum += v;
        count++;
      }
      out[i] = count === period ? sum / count : null;
    }
    return out;
  }

  /**
   * Percentile rank of `value` within `sample`. Returns 0..100 (inclusive).
   * 0 = nothing in sample is below `value`; 100 = everything is. Uses the
   * "closest-rank" definition; ties count as half-below for unbiased ranking.
   */
  private percentileOf(value: number, sample: number[]): number {
    if (sample.length === 0) return 50;
    let below = 0;
    let equal = 0;
    for (const v of sample) {
      if (v < value) below++;
      else if (v === value) equal++;
    }
    return ((below + equal / 2) / sample.length) * 100;
  }

  private movingAverage(values: number[], period: number): number {
    if (values.length === 0) return 0;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }
}
