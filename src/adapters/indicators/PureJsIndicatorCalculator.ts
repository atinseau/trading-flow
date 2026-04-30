import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import type { Candle } from "@domain/schemas/Candle";
import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";

export class PureJsIndicatorCalculator implements IndicatorCalculator {
  async compute(
    candles: Candle[],
    plugins: ReadonlyArray<IndicatorPlugin>,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const p of plugins) {
      Object.assign(out, p.computeScalars(candles));
    }
    return out;
  }

  async computeSeries(
    candles: Candle[],
    plugins: ReadonlyArray<IndicatorPlugin>,
  ): Promise<Record<string, IndicatorSeriesContribution>> {
    const out: Record<string, IndicatorSeriesContribution> = {};
    for (const p of plugins) {
      out[p.id] = p.computeSeries(candles);
    }
    return out;
  }
}
