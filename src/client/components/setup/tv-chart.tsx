import { TradingViewChart } from "@client/components/charts/TradingViewChart";
import type { Time, UTCTimestamp } from "lightweight-charts";
import { useMemo } from "react";

export type Candle = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type Level = { price: number; label: string; color: string };

export function TVChart(props: {
  candles: Candle[];
  levels: Level[];
  onTimeClick?: (time: Time) => void;
}) {
  const adapted = useMemo(
    () =>
      props.candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    [props.candles],
  );
  const priceLines = useMemo(
    () =>
      props.levels.map((l) => ({
        price: l.price,
        color: l.color,
        title: l.label,
        style: 2 as 0 | 1 | 2,
      })),
    [props.levels],
  );
  return (
    <TradingViewChart
      candles={adapted}
      priceLines={priceLines}
      enableControls={false}
      enableFullscreen
      height={360}
      onChartReady={(chart) => {
        if (props.onTimeClick) {
          chart.subscribeClick((p) => {
            if (p.time) props.onTimeClick?.(p.time);
          });
        }
      }}
    />
  );
}
