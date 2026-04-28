import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";
import type { Indicators } from "@domain/schemas/Indicators";

export class FakeIndicatorCalculator implements IndicatorCalculator {
  fixed: Indicators = {
    rsi: 50,
    ema20: 100,
    ema50: 100,
    ema200: 100,
    atr: 1,
    atrMa20: 1,
    volumeMa20: 100,
    lastVolume: 100,
    recentHigh: 110,
    recentLow: 90,
  };

  async compute(_candles: Candle[]): Promise<Indicators> {
    return { ...this.fixed };
  }

  set(ind: Partial<Indicators>): void {
    this.fixed = { ...this.fixed, ...ind };
  }
}
