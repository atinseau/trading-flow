import { createChart, type IChartApi, type ISeriesApi, type Time } from "lightweight-charts";
import { useEffect, useRef } from "react";

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<ReturnType<NonNullable<typeof seriesRef.current>["createPriceLine"]>[]>(
    [],
  );
  const onTimeClickRef = useRef(props.onTimeClick);
  onTimeClickRef.current = props.onTimeClick;

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "rgb(229, 231, 235)",
      },
      grid: {
        vertLines: { color: "rgba(60, 64, 72, 0.4)" },
        horzLines: { color: "rgba(60, 64, 72, 0.4)" },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height: 360,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const onResize = (): void => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);

    chart.subscribeClick((p) => {
      if (p.time) onTimeClickRef.current?.(p.time);
    });

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.setData(props.candles);
  }, [props.candles]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = props.levels.map((lvl) =>
      series.createPriceLine({
        price: lvl.price,
        color: lvl.color,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: lvl.label,
      }),
    );
  }, [props.levels]);

  return (
    <div
      ref={containerRef}
      className="w-full bg-card border border-border rounded-md overflow-hidden"
    />
  );
}
