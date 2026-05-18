import {
  CandlestickSeries,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

function SmokeChart() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart: IChartApi = createChart(ref.current, {
      width: 1024,
      height: 500,
      layout: { background: { color: "#131722" }, textColor: "#d1d4dc" },
    });
    const s = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
    });
    const now = Math.floor(Date.now() / 1000);
    s.setData(
      Array.from({ length: 50 }, (_, i) => ({
        time: (now - (50 - i) * 3600) as UTCTimestamp,
        open: 100 + i,
        high: 102 + i,
        low: 98 + i,
        close: 101 + i,
      })),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, []);
  return <div ref={ref} style={{ width: 1024, height: 500 }} />;
}

export default {
  title: "Charts/Smoke",
  component: SmokeChart,
};

export const Default = { args: {} };
