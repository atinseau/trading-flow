import type { Candle } from "@domain/schemas/Candle";
import type { Indicators } from "@domain/schemas/Indicators";

export interface IndicatorCalculator {
  compute(candles: Candle[]): Promise<Indicators>;
}
