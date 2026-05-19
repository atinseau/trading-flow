import { volumePlugin } from "@adapters/indicators/plugins/volume";
import { TradingViewChart } from "@client/components/charts/TradingViewChart";
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
 * Full-width interactive candlestick + volume chart.
 * Bigger / more detailed than the per-setup TVChart — used on the asset
 * detail page for browsing.
 *
 * Volume is rendered via the unified plugin pipeline (D1) — the plugin
 * emits a compound contribution (histogram bars + MA20 line) natively, so
 * no inline shaping is needed here.
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

  const indicators = useMemo(() => {
    const candlesForCompute = candles.map((c) => ({
      timestamp: new Date(c.time * 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    return [
      {
        id: "volume",
        plugin: volumePlugin as never,
        contribution: volumePlugin.computeSeries(candlesForCompute as never),
      },
    ];
  }, [candles]);

  return (
    <TradingViewChart
      candles={adapted}
      height={480}
      enableControls={false}
      enableFullscreen={false}
      indicators={indicators}
    />
  );
}
