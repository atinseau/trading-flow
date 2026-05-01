import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import type { Candle } from "@domain/schemas/Candle";
import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";

/** Neutral indicator set compatible with IndicatorScalars (Record<string, unknown>). */
export const NEUTRAL_INDICATORS: Record<string, unknown> = {
  rsi: 50,
  ema20: 100,
  ema50: 100,
  ema200: 100,
  emaShort: 100,
  emaMid: 100,
  emaLong: 100,
  atr: 1,
  atrMa20: 1,
  atrZScore200: 0,
  volumeMa20: 100,
  lastVolume: 100,
  recentHigh: 110,
  recentLow: 90,
  bbBandwidthPct: 5,
};

export class FakeIndicatorCalculator implements IndicatorCalculator {
  fixed: Record<string, unknown> = { ...NEUTRAL_INDICATORS };

  async compute(
    _candles: Candle[],
    _plugins: ReadonlyArray<IndicatorPlugin>,
    _paramsByPlugin?: Readonly<Record<string, Record<string, unknown>>>,
  ): Promise<Record<string, unknown>> {
    return { ...this.fixed };
  }

  async computeSeries(
    _candles: Candle[],
    _plugins: ReadonlyArray<IndicatorPlugin>,
    _paramsByPlugin?: Readonly<Record<string, Record<string, unknown>>>,
  ): Promise<Record<string, IndicatorSeriesContribution>> {
    return {};
  }

  set(ind: Partial<Record<string, unknown>>): void {
    this.fixed = { ...this.fixed, ...ind };
  }
}
