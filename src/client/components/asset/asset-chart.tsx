import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

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
 */
export function AssetChart({ candles }: { candles: AssetCandle[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "transparent" }, textColor: "rgb(229, 231, 235)" },
      grid: {
        vertLines: { color: "rgba(60, 64, 72, 0.4)" },
        horzLines: { color: "rgba(60, 64, 72, 0.4)" },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderVisible: false },
      rightPriceScale: { borderVisible: false },
      width: containerRef.current.clientWidth,
      height: 480,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.25 } });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const onResize = (): void => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    const candleData = candles.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const volumeData = candles.map((c) => ({
      time: c.time as Time,
      value: c.volume,
      color: c.close >= c.open ? "rgba(16, 185, 129, 0.5)" : "rgba(239, 68, 68, 0.5)",
    }));
    candleSeriesRef.current.setData(candleData);
    volumeSeriesRef.current.setData(volumeData);
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return (
    <div
      ref={containerRef}
      className="w-full bg-card border border-border rounded-md overflow-hidden"
    />
  );
}
