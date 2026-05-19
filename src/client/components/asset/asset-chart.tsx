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
 * Volume is rendered via the unified plugin pipeline (D1): raw bars as a
 * histogram + volumeMa20 line via a compound contribution.
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
    // Map AssetCandle → Candle domain shape for volumePlugin.computeSeries.
    const candlesForCompute = candles.map((c) => ({
      timestamp: new Date(c.time * 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    // Raw volume histogram bars with green/red coloring per candle direction.
    const volumeBars = {
      kind: "histogram" as const,
      values: candles.map((c) => ({
        value: c.volume,
        color: c.close >= c.open ? "rgba(16, 185, 129, 0.5)" : "rgba(239, 68, 68, 0.5)",
      })),
    };

    // volumeMa20 line from the plugin.
    const maContribution = volumePlugin.computeSeries(candlesForCompute as never);

    return [
      {
        id: "volume",
        plugin: volumePlugin as never,
        contribution: { kind: "compound" as const, parts: [volumeBars, maContribution] },
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
