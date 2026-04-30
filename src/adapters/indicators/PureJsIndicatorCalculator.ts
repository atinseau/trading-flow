import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";
import type { Indicators } from "@domain/schemas/Indicators";
import { IndicatorsSchema } from "@domain/schemas/Indicators";

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
    return IndicatorsSchema.parse({
      rsi: this.rsi(closes, 14),
      ema20: this.ema(closes, 20),
      ema50: this.ema(closes, 50),
      ema200: this.ema(closes, 200),
      atr: atrSeries[atrSeries.length - 1] ?? 0,
      atrMa20: this.movingAverage(atrSeries, 20),
      volumeMa20: this.movingAverage(volumes, 20),
      lastVolume: volumes[volumes.length - 1] ?? 0,
      recentHigh: Math.max(...highs.slice(-50)),
      recentLow: Math.min(...lows.slice(-50)),
    });
  }

  private rsi(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;

    // Step 1: initial average over the first `period` differences
    // (closes[1] - closes[0], ..., closes[period] - closes[period-1])
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

    // Step 2: Wilder's smoothing for each subsequent close.
    // avgGain_new = (avgGain_prev * (period - 1) + currentGain) / period
    // avgLoss_new = (avgLoss_prev * (period - 1) + currentLoss) / period
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

  private movingAverage(values: number[], period: number): number {
    if (values.length === 0) return 0;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }
}
