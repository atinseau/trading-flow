import { structureLevelsPlugin } from "@adapters/indicators/plugins/structure_levels";
import { TradingViewChart } from "@client/components/charts/TradingViewChart";
import fixtureBearish from "@test-fixtures/candles/btcusdt-1h-bearish-200.json";
import fixtureBullish from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import type { UTCTimestamp } from "lightweight-charts";

function build(fixture: typeof fixtureBullish) {
  const candles = fixture.map((c) => ({
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
  const candlesForCompute = fixture.map((c) => ({
    timestamp: new Date(c.time * 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
  return {
    candles,
    indicators: [
      {
        id: structureLevelsPlugin.id,
        plugin: structureLevelsPlugin as typeof structureLevelsPlugin & {
          renderConfig: NonNullable<typeof structureLevelsPlugin.renderConfig>;
        },
        // biome-ignore lint/suspicious/noExplicitAny: bypass strict Candle typing for fixture
        contribution: structureLevelsPlugin.computeSeries(candlesForCompute as any),
      },
    ],
  };
}

export default { title: "Plugins/Structure Levels", component: TradingViewChart };

export const Bullish = { args: build(fixtureBullish) };
export const Bearish = { args: build(fixtureBearish) };
