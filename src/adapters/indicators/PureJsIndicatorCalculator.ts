import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import type { Candle } from "@domain/schemas/Candle";
import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";

export class PureJsIndicatorCalculator implements IndicatorCalculator {
  async compute(
    candles: Candle[],
    plugins: ReadonlyArray<IndicatorPlugin>,
    paramsByPlugin?: Readonly<Record<string, Record<string, unknown>>>,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const p of plugins) {
      const params = paramsByPlugin?.[p.id] ?? p.defaultParams;
      Object.assign(out, p.computeScalars(candles, params));
    }
    return out;
  }

  async computeSeries(
    candles: Candle[],
    plugins: ReadonlyArray<IndicatorPlugin>,
    paramsByPlugin?: Readonly<Record<string, Record<string, unknown>>>,
  ): Promise<Record<string, IndicatorSeriesContribution>> {
    const out: Record<string, IndicatorSeriesContribution> = {};
    for (const p of plugins) {
      const params = paramsByPlugin?.[p.id] ?? p.defaultParams;
      out[p.id] = p.computeSeries(candles, params);
    }
    return out;
  }
}
