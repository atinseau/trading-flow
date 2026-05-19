import { BandsPrimitive } from "@adapters/chart/bandsPrimitive";
import { createTradingViewChart } from "@adapters/chart/chartBootstrap";
import fixtureBullish from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import type { UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

function BandsDemo({
  bands,
}: {
  bands: Array<{ topPrice: number; bottomPrice: number; fillColor: string }>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const { chart, candleSeries, dispose } = createTradingViewChart(ref.current, {
      width: 1024,
      height: 500,
      naked: false,
    });
    candleSeries.setData(
      fixtureBullish.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    const primitive = new BandsPrimitive(candleSeries, bands);
    candleSeries.attachPrimitive(primitive);
    chart.timeScale().fitContent();
    return () => {
      candleSeries.detachPrimitive(primitive);
      dispose();
    };
  }, [bands]);
  return <div ref={ref} style={{ width: 1024, height: 500 }} />;
}

export default { title: "Chart/BandsPrimitive", component: BandsDemo };

export const Uptrend = {
  args: {
    bands: [
      { topPrice: 118, bottomPrice: 115, fillColor: "rgba(255, 215, 0, 0.18)" },
      { topPrice: 115, bottomPrice: 112, fillColor: "rgba(76, 175, 80, 0.12)" },
      { topPrice: 112, bottomPrice: 108, fillColor: "rgba(33, 150, 243, 0.10)" },
      { topPrice: 108, bottomPrice: 105, fillColor: "rgba(244, 67, 54, 0.10)" },
    ],
  },
};

export const Downtrend = {
  args: {
    bands: [{ topPrice: 95, bottomPrice: 92, fillColor: "rgba(255, 215, 0, 0.18)" }],
  },
};

export const NoBands = { args: { bands: [] } };
