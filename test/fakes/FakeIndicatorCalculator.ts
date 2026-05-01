import type { IndicatorCalculator, IndicatorSeries } from "@domain/ports/IndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";
import type { Indicators } from "@domain/schemas/Indicators";

export const NEUTRAL_INDICATORS: Indicators = {
  rsi: 50,
  ema20: 100,
  ema50: 100,
  ema200: 100,
  atr: 1,
  atrMa20: 1,
  atrZScore200: 0,
  volumeMa20: 100,
  lastVolume: 100,
  volumePercentile200: 50,
  recentHigh: 110,
  recentLow: 90,
  vwapSession: 100,
  priceVsVwapPct: 0,
  bbUpper: 102,
  bbMiddle: 100,
  bbLower: 98,
  bbBandwidthPct: 4,
  bbBandwidthPercentile200: 50,
  macd: 0,
  macdSignal: 0,
  macdHist: 0,
  lastSwingHigh: null,
  lastSwingHighAge: null,
  lastSwingLow: null,
  lastSwingLowAge: null,
  bosState: "none",
  pocPrice: 100,
  equalHighsCount: 0,
  equalLowsCount: 0,
  topEqualHighs: [],
  topEqualLows: [],
};

export class FakeIndicatorCalculator implements IndicatorCalculator {
  fixed: Indicators = { ...NEUTRAL_INDICATORS };

  async compute(_candles: Candle[]): Promise<Indicators> {
    return { ...this.fixed };
  }

  async computeSeries(candles: Candle[]): Promise<IndicatorSeries> {
    const flat = (v: number) => candles.map(() => v);
    return {
      ema20: flat(this.fixed.ema20),
      ema50: flat(this.fixed.ema50),
      ema200: flat(this.fixed.ema200),
      vwap: flat(this.fixed.vwapSession),
      bbUpper: flat(this.fixed.bbUpper),
      bbMiddle: flat(this.fixed.bbMiddle),
      bbLower: flat(this.fixed.bbLower),
      rsi: flat(this.fixed.rsi),
      atr: flat(this.fixed.atr),
      atrMa20: flat(this.fixed.atrMa20),
      volumeMa20: flat(this.fixed.volumeMa20),
      macd: flat(this.fixed.macd),
      macdSignal: flat(this.fixed.macdSignal),
      macdHist: flat(this.fixed.macdHist),
      swingHighs: [],
      swingLows: [],
      fvgs: [],
      equalHighs: [],
      equalLows: [],
    };
  }

  set(ind: Partial<Indicators>): void {
    this.fixed = { ...this.fixed, ...ind };
  }
}
