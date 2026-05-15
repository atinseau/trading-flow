import type {
  IndicatorSeriesContribution,
  ReplayEventRow,
  SetupProjectionRow,
} from "@client/components/replay/replay-types";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import { applyIndicatorToChart, type IndicatorPane } from "./applyIndicatorToChart";
import { colorForSetup, visualForEvent } from "./replay-marker-config";

/**
 * Stable color palettes per indicator id. We pick deterministically so EMA
 * stacks always read short=blue / mid=amber / long=red and RSI sits on a
 * teal line — regardless of the order plugins appear in the response.
 * Indicators not listed fall back to a generic ramp.
 */
const INDICATOR_PALETTES: Record<string, string[]> = {
  ema_stack: ["#3b82f6", "#f59e0b", "#ef4444"],
  rsi: ["#14b8a6"],
  volume: ["#94a3b8"],
  macd: ["#3b82f6", "#f59e0b"],
  bollinger: ["#a78bfa", "#a78bfa", "#a78bfa"],
  vwap: ["#10b981"],
  atr: ["#f97316"],
  swings_bos: ["#94a3b8"],
  structure_levels: ["#9ca3af"],
  liquidity_pools: ["#a78bfa"],
};
const FALLBACK_PALETTE = ["#94a3b8", "#3b82f6", "#f59e0b", "#10b981", "#a78bfa"];

export type ReplayCandle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

/**
 * Chart for a replay session. Renders all candles between
 * `windowStartAt - lookback` and `windowEndAt`, split into three series
 * so the user can see exactly where the replay window sits relative to
 * the lookback context:
 *
 *  - **Lookback**  (candle.time < windowStartAt)         — muted / desaturated, "context the bot sees but that's before your chosen window"
 *  - **Revealed**  (windowStartAt ≤ candle.time ≤ playheadAt) — full colors, "what the bot has scored so far"
 *  - **Future**    (candle.time > playheadAt)            — heavily dimmed, "visible to you, not to the bot"
 *
 * A horizontal price line at the open price of the windowStartAt candle
 * acts as a subtle anchor too, but the boundary is mainly conveyed by
 * the color transition between the lookback and revealed series.
 *
 * Markers from replay_events with `occurredAt > playheadAt` are filtered
 * out. Active setup filter: when `activeSetupId` is non-null, markers for
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
  /** Indicator series keyed by plugin id — `OhlcvResponse.indicators`. */
  indicators?: Record<string, IndicatorSeriesContribution>;
  /** Pane hint per indicator — `OhlcvResponse.indicatorMeta`. */
  indicatorMeta?: Record<string, { pane: IndicatorPane }>;
  /** Subset of indicator ids the user wants to see. `null`/undefined → all. */
  visibleIndicators?: ReadonlySet<string> | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lookbackSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const visibleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const futureSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<
    ReturnType<NonNullable<typeof visibleSeriesRef.current>["createPriceLine"]>[]
  >([]);
  // Indicator markers live in a separate bucket from event markers so the
  // two effects don't clobber each other when one re-runs.
  const indicatorMarkersRef = useRef<SeriesMarker<Time>[]>([]);
  const eventMarkersRef = useRef<SeriesMarker<Time>[]>([]);
  const indicatorCleanupsRef = useRef<Array<{ cleanup: () => void }>>([]);

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
    // Lookback context — candles before windowStartAt. Muted to a neutral
    // slate-gray so they read as "context only, outside your window".
    const lookback = chart.addSeries(CandlestickSeries, {
      upColor: "rgba(148, 163, 184, 0.55)",
      downColor: "rgba(100, 116, 139, 0.55)",
      borderUpColor: "rgba(148, 163, 184, 0.55)",
      borderDownColor: "rgba(100, 116, 139, 0.55)",
      wickUpColor: "rgba(148, 163, 184, 0.55)",
      wickDownColor: "rgba(100, 116, 139, 0.55)",
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
    lookbackSeriesRef.current = lookback;
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
      lookbackSeriesRef.current = null;
      visibleSeriesRef.current = null;
      futureSeriesRef.current = null;
      markersPluginRef.current = null;
    };
  }, []);

  // ── update candles split into lookback / revealed / future ─────────
  const playheadSec = useMemo(
    () => Math.floor(props.playheadAt.getTime() / 1000),
    [props.playheadAt],
  );
  const windowStartSec = useMemo(
    () => Math.floor(props.windowStartAt.getTime() / 1000),
    [props.windowStartAt],
  );
  useEffect(() => {
    const lookback = lookbackSeriesRef.current;
    const visible = visibleSeriesRef.current;
    const future = futureSeriesRef.current;
    if (!lookback || !visible || !future) return;
    type Row = { time: UTCTimestamp; open: number; high: number; low: number; close: number };
    const lookbackData: Row[] = [];
    const visibleData: Row[] = [];
    const futureData: Row[] = [];
    for (const c of props.candles) {
      const t = Math.floor(new Date(c.timestamp).getTime() / 1000) as UTCTimestamp;
      const row: Row = { time: t, open: c.open, high: c.high, low: c.low, close: c.close };
      if (t < windowStartSec) lookbackData.push(row);
      else if (t <= playheadSec) visibleData.push(row);
      else futureData.push(row);
    }
    lookback.setData(lookbackData);
    visible.setData(visibleData);
    future.setData(futureData);
  }, [props.candles, playheadSec, windowStartSec]);

  // ── update event markers ───────────────────────────────────────────
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
    eventMarkersRef.current = markers as unknown as SeriesMarker<Time>[];
    plugin.setMarkers([...eventMarkersRef.current, ...indicatorMarkersRef.current]);
  }, [props.events, props.activeSetupId, props.playheadAt]);

  // ── update indicators (lines / panes / markers / priceLines) ──────
  const candleTimes = useMemo(
    () =>
      props.candles.map((c) => Math.floor(new Date(c.timestamp).getTime() / 1000) as UTCTimestamp),
    [props.candles],
  );
  useEffect(() => {
    const chart = chartRef.current;
    const mainSeries = visibleSeriesRef.current;
    const plugin = markersPluginRef.current;
    if (!chart || !mainSeries || !plugin) return;
    // Tear down previously applied indicators ; the helper's cleanup
    // removes the line series + price lines it created.
    for (const c of indicatorCleanupsRef.current) c.cleanup();
    indicatorCleanupsRef.current = [];
    indicatorMarkersRef.current = [];

    const all = props.indicators ?? {};
    const meta = props.indicatorMeta ?? {};
    const visible = props.visibleIndicators;
    for (const [id, contribution] of Object.entries(all)) {
      if (visible && !visible.has(id)) continue;
      const pane: IndicatorPane = meta[id]?.pane ?? "price_overlay";
      const palette = INDICATOR_PALETTES[id] ?? FALLBACK_PALETTE;
      const result = applyIndicatorToChart(chart, contribution, {
        id,
        pane,
        candleTimes,
        mainSeries,
        markerBucket: indicatorMarkersRef.current,
        colorPalette: palette,
      });
      indicatorCleanupsRef.current.push(result);
    }
    // Re-publish the merged marker list (indicator markers may have been
    // updated by the dispatch).
    plugin.setMarkers([...eventMarkersRef.current, ...indicatorMarkersRef.current]);

    return () => {
      // Component unmount or deps change → drop everything we created.
      for (const c of indicatorCleanupsRef.current) c.cleanup();
      indicatorCleanupsRef.current = [];
      indicatorMarkersRef.current = [];
    };
    // Re-run on any input change. The chart cleanup-and-reapply is cheap
    // (it's the same series objects either way), so we accept the extra
    // work in exchange for simpler deps + Biome compliance.
  }, [candleTimes, props.indicators, props.indicatorMeta, props.visibleIndicators]);

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
