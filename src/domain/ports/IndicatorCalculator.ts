import type { Candle } from "@domain/schemas/Candle";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";

export type IndicatorSeries = Record<string, IndicatorSeriesContribution>;

export interface IndicatorCalculator {
  compute(
    candles: Candle[],
    plugins: ReadonlyArray<IndicatorPlugin>,
    paramsByPlugin?: Readonly<Record<string, Record<string, unknown>>>,
  ): Promise<Record<string, unknown>>;
  computeSeries(
    candles: Candle[],
    plugins: ReadonlyArray<IndicatorPlugin>,
    paramsByPlugin?: Readonly<Record<string, Record<string, unknown>>>,
  ): Promise<Record<string, IndicatorSeriesContribution>>;
}
