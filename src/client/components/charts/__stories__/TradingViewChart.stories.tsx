import { emaStackPlugin } from "@adapters/indicators/plugins/ema_stack";
import { rsiPlugin } from "@adapters/indicators/plugins/rsi";
import { TradingViewChart } from "@client/components/charts/TradingViewChart";
import fixtureBullish from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import type { UTCTimestamp } from "lightweight-charts";

const candles = fixtureBullish.map((c) => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
}));

// Plugins for the .computeSeries() call expect Candle objects with `timestamp: Date`,
// not the UTCTimestamp-based shape used by lightweight-charts directly.
const candlesForCompute = fixtureBullish.map((c) => ({
  timestamp: new Date(c.time * 1000),
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: c.volume,
}));

// Until Phase 4 adds `renderConfig` directly to each plugin's exported object,
// inline a temporary shim so the stories compile. After Phase 4, drop the
// inline shim and use `plugin.renderConfig` directly.
const tempRenderConfig = {
  ema_stack: {
    pane: "price_overlay" as const,
    palette: ["#3b82f6", "#f59e0b", "#ef4444"],
    seriesLabels: { ema_short: "EMA short", ema_mid: "EMA mid", ema_long: "EMA long" },
  },
  rsi: {
    pane: "secondary" as const,
    palette: ["#14b8a6"],
    secondaryPaneStretch: 13,
    seriesLabels: { rsi: "RSI" },
  },
};

export default { title: "Charts/TradingViewChart", component: TradingViewChart };

export const Naked = { args: { candles } };

export const SingleIndicator = {
  args: {
    candles,
    indicators: [
      {
        id: "rsi",
        plugin: { ...rsiPlugin, renderConfig: tempRenderConfig.rsi },
        contribution: rsiPlugin.computeSeries(candlesForCompute as never),
      },
    ],
  },
};

export const PriceOverlayStack = {
  args: {
    candles,
    indicators: [
      {
        id: "ema_stack",
        plugin: { ...emaStackPlugin, renderConfig: tempRenderConfig.ema_stack },
        contribution: emaStackPlugin.computeSeries(candlesForCompute as never),
      },
    ],
  },
};

export const WithControls = {
  args: {
    candles,
    enableControls: true,
    indicators: [
      {
        id: "ema_stack",
        plugin: { ...emaStackPlugin, renderConfig: tempRenderConfig.ema_stack },
        contribution: emaStackPlugin.computeSeries(candlesForCompute as never),
      },
      {
        id: "rsi",
        plugin: { ...rsiPlugin, renderConfig: tempRenderConfig.rsi },
        contribution: rsiPlugin.computeSeries(candlesForCompute as never),
      },
    ],
  },
};

export const WithPriceLines = {
  args: {
    candles,
    priceLines: [
      { price: 115, color: "#10b981", title: "TP1", style: 2 as 0 | 1 | 2 },
      { price: 105, color: "#ef4444", title: "SL", style: 2 as 0 | 1 | 2 },
      { price: 110, color: "#3b82f6", title: "Entry", style: 0 as 0 | 1 | 2 },
    ],
  },
};
