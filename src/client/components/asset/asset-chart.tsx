import { REGISTRY } from "@adapters/indicators/IndicatorRegistry";
import { type IndicatorEntry, TradingViewChart } from "@client/components/charts/TradingViewChart";
import type { UTCTimestamp } from "lightweight-charts";
import { useMemo } from "react";

export type AssetCandle = {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Full-width interactive candlestick chart with optional indicator overlays.
 *
 * Every bundled indicator is pre-computed client-side from the candle
 * history (default params per plugin) and exposed via the framework's
 * built-in chip controls — user picks which ones to reveal. Plugins that
 * self-disable on unsupported data (volume + vwap on zero-volume forex
 * pairs) return an empty compound and TradingViewChart drops them from
 * the chip list automatically.
 *
 * No backend coupling here : the asset page doesn't know about watches,
 * so the indicator set is the full REGISTRY rather than a watch-config
 * subset.
 */
export function AssetChart({ candles }: { candles: AssetCandle[] }) {
  const adapted = useMemo(
    () =>
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    [candles],
  );

  const indicators: IndicatorEntry[] = useMemo(() => {
    const candlesForCompute = candles.map((c) => ({
      timestamp: new Date(c.time * 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    return REGISTRY.map((plugin) => ({
      id: plugin.id,
      plugin: plugin as IndicatorEntry["plugin"],
      // biome-ignore lint/suspicious/noExplicitAny: bypass strict Candle typing for fixture-shaped data
      contribution: plugin.computeSeries(candlesForCompute as any),
    }));
  }, [candles]);

  // Volume defaults visible (universal context when the plugin emits it),
  // the rest hidden so the chart stays uncluttered. Volume plugins that
  // self-disable on zero-volume data are filtered out by TradingViewChart
  // before they reach the chips — `initialVisibility` for volume becomes
  // a no-op in that case.
  const initialVisibility = useMemo(
    () => Object.fromEntries(REGISTRY.map((p) => [p.id, p.id === "volume"])),
    [],
  );

  return (
    <TradingViewChart
      candles={adapted}
      indicators={indicators}
      enableControls
      enableFullscreen
      initialVisibility={initialVisibility}
      height={480}
    />
  );
}
