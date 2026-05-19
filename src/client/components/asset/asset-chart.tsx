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
 * Used on the asset detail page for browsing. ALL bundled indicators are
 * pre-computed client-side from the candle history (default params per
 * plugin) and exposed via the framework's built-in chip controls — user
 * picks which ones to reveal. Volume defaults visible since it's the most
 * universal context, the rest start hidden.
 *
 * No backend coupling here : the asset page doesn't know about watches, so
 * the indicator set is the full REGISTRY rather than a watch-config subset.
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

  // Start with volume visible (universal context), the rest hidden so the
  // chart remains uncluttered. User reveals via the framework chips.
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
