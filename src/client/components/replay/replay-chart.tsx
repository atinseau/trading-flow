import type { ReplayEventRow, SetupProjectionRow } from "@client/components/replay/replay-types";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import { colorForSetup, visualForEvent } from "./replay-marker-config";

export type ReplayCandle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

/**
 * Chart for a replay session. Renders all candles between
 * `windowStartAt - lookback` and `windowEndAt`. Candles strictly past
 * `playheadAt` are dimmed via a transparent overlay series to indicate
 * "future" (visible to the user, not to the bot). Markers from
 * replay_events with `occurredAt > playheadAt` are filtered out.
 *
 * Active setup filter: when `activeSetupId` is non-null, markers for
 * other setups are filtered out as well — the user is focused on one
 * setup. Price lines (entry/SL/TP) of `aliveSetups` matching the filter
 * are drawn.
 */
export function ReplayChart(props: {
  candles: ReplayCandle[];
  events: ReplayEventRow[];
  setups: SetupProjectionRow[];
  windowStartAt: Date;
  windowEndAt: Date;
  playheadAt: Date;
  activeSetupId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const visibleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const futureSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<
    ReturnType<NonNullable<typeof visibleSeriesRef.current>["createPriceLine"]>[]
  >([]);

  // ── mount ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "transparent" }, textColor: "rgb(229, 231, 235)" },
      grid: {
        vertLines: { color: "rgba(60, 64, 72, 0.4)" },
        horzLines: { color: "rgba(60, 64, 72, 0.4)" },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height: 380,
    });
    const visible = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });
    const future = chart.addSeries(CandlestickSeries, {
      upColor: "rgba(16, 185, 129, 0.25)",
      downColor: "rgba(239, 68, 68, 0.25)",
      borderUpColor: "rgba(16, 185, 129, 0.25)",
      borderDownColor: "rgba(239, 68, 68, 0.25)",
      wickUpColor: "rgba(16, 185, 129, 0.25)",
      wickDownColor: "rgba(239, 68, 68, 0.25)",
    });
    const markersPlugin = createSeriesMarkers<Time>(visible);

    chartRef.current = chart;
    visibleSeriesRef.current = visible;
    futureSeriesRef.current = future;
    markersPluginRef.current = markersPlugin;

    const onResize = (): void => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      visibleSeriesRef.current = null;
      futureSeriesRef.current = null;
      markersPluginRef.current = null;
    };
  }, []);

  // ── update candles split by playhead ───────────────────────────────
  const playheadSec = useMemo(
    () => Math.floor(props.playheadAt.getTime() / 1000),
    [props.playheadAt],
  );
  useEffect(() => {
    const visible = visibleSeriesRef.current;
    const future = futureSeriesRef.current;
    if (!visible || !future) return;
    const visibleData: {
      time: UTCTimestamp;
      open: number;
      high: number;
      low: number;
      close: number;
    }[] = [];
    const futureData: typeof visibleData = [];
    for (const c of props.candles) {
      const t = Math.floor(new Date(c.timestamp).getTime() / 1000) as UTCTimestamp;
      const row = { time: t, open: c.open, high: c.high, low: c.low, close: c.close };
      if (t <= playheadSec) visibleData.push(row);
      else futureData.push(row);
    }
    visible.setData(visibleData);
    future.setData(futureData);
  }, [props.candles, playheadSec]);

  // ── update markers ──────────────────────────────────────────────────
  useEffect(() => {
    const plugin = markersPluginRef.current;
    if (!plugin) return;
    const playMs = props.playheadAt.getTime();
    const markers = props.events
      .filter((e) => new Date(e.occurredAt).getTime() <= playMs)
      .filter((e) => !props.activeSetupId || e.setupId === props.activeSetupId)
      .map((e) => {
        const v = visualForEvent(e.type);
        if (!v) return null;
        const color = colorForSetup(e.setupId);
        return {
          time: Math.floor(new Date(e.occurredAt).getTime() / 1000) as UTCTimestamp,
          position: v.position,
          shape: v.shape,
          color,
          text: v.text,
          id: e.id,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    plugin.setMarkers(markers);
  }, [props.events, props.activeSetupId, props.playheadAt]);

  // ── update price lines from active setups ──────────────────────────
  useEffect(() => {
    const visible = visibleSeriesRef.current;
    if (!visible) return;
    for (const line of priceLinesRef.current) visible.removePriceLine(line);
    priceLinesRef.current = [];

    const scoped = props.activeSetupId
      ? props.setups.filter((s) => s.setupId === props.activeSetupId)
      : props.setups;

    for (const s of scoped) {
      const color = colorForSetup(s.setupId);
      if (s.entry !== null) {
        priceLinesRef.current.push(
          visible.createPriceLine({
            price: s.entry,
            color,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: "Entry",
          }),
        );
      }
      if (s.stopLoss !== null) {
        priceLinesRef.current.push(
          visible.createPriceLine({
            price: s.stopLoss,
            color: "#f87171",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: "SL",
          }),
        );
      }
      if (s.takeProfit) {
        s.takeProfit.forEach((tp, i) => {
          priceLinesRef.current.push(
            visible.createPriceLine({
              price: tp,
              color: "#34d399",
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: `TP${i + 1}`,
            }),
          );
        });
      }
      if (s.invalidationLevel !== null) {
        priceLinesRef.current.push(
          visible.createPriceLine({
            price: s.invalidationLevel,
            color: "#9ca3af",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: "Invalidation",
          }),
        );
      }
    }
  }, [props.setups, props.activeSetupId]);

  return (
    <div
      ref={containerRef}
      className="w-full bg-card border border-border rounded-md overflow-hidden"
    />
  );
}
