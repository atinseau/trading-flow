import { applyRightOffset, createTradingViewChart } from "@adapters/chart/chartBootstrap";
import { applyContribution, type RenderConfig } from "@adapters/chart/contributionRenderer";
import { allocatePanes } from "@adapters/chart/paneAllocator";
import { cn } from "@client/lib/utils";
import type { IndicatorSeriesContribution } from "@domain/charts/types";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import type { IChartApi, ISeriesApi, SeriesMarker, Time, UTCTimestamp } from "lightweight-charts";
import { Maximize2, Minimize2 } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ControlsLayout, IndicatorControlPanel } from "./IndicatorControlPanel";

export type IndicatorEntry = {
  id: string;
  plugin: IndicatorPlugin & { renderConfig: RenderConfig };
  contribution: IndicatorSeriesContribution;
};

export type PriceLineSpec = {
  price: number;
  color: string;
  title: string;
  style?: 0 | 1 | 2;
};

export type EventMarkerSpec = {
  time: UTCTimestamp;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  text: string;
};

export type TradingViewChartProps = {
  candles: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>;
  indicators?: IndicatorEntry[];
  priceLines?: PriceLineSpec[];
  markers?: EventMarkerSpec[];
  /** When true, render the indicator toggle panel. State lives inside this
   *  component — caller does not manage it. Default false (read-only). */
  enableControls?: boolean;
  initialVisibility?: Record<string, boolean>;
  controlsLayout?: ControlsLayout;
  /** Fullscreen via F11 + corner button. Default true ; wrappers opt out
   *  (asset-chart) by passing false. */
  enableFullscreen?: boolean;
  /** Chart container height in normal (non-fullscreen) mode. */
  height?: number;
  className?: string;
  onChartReady?: (chart: IChartApi) => void;
};

export function TradingViewChart(props: TradingViewChartProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const indicatorCleanupsRef = useRef<Array<{ cleanup: () => void }>>([]);
  const indicatorMarkersRef = useRef<SeriesMarker<Time>[]>([]);
  const priceLinesRef = useRef<
    Array<{
      series: ISeriesApi<"Candlestick">;
      line: ReturnType<NonNullable<typeof candleSeriesRef.current>["createPriceLine"]>;
    }>
  >([]);
  const markersPluginRef = useRef<{ setMarkers: (m: SeriesMarker<Time>[]) => void } | null>(null);

  const height = props.height ?? 380;
  const enableControls = props.enableControls ?? false;
  const enableFullscreen = props.enableFullscreen ?? true;
  const controlsLayout: ControlsLayout = props.controlsLayout ?? "top-chips";

  const [visibility, setVisibility] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const i of props.indicators ?? []) {
      init[i.id] = props.initialVisibility?.[i.id] ?? !enableControls;
    }
    return init;
  });

  // Sync visibility when the indicators list changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-sync on id-set change, not data change
  useEffect(() => {
    setVisibility((prev) => {
      const next: Record<string, boolean> = {};
      for (const i of props.indicators ?? []) {
        next[i.id] = prev[i.id] ?? props.initialVisibility?.[i.id] ?? !enableControls;
      }
      return next;
    });
  }, [(props.indicators ?? []).map((i) => i.id).join(",")]);

  // Mount the chart once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect
  useEffect(() => {
    if (!containerRef.current) return;
    const { chart, candleSeries, dispose } = createTradingViewChart(containerRef.current, {
      width: containerRef.current.clientWidth || 800,
      height,
      naked: (props.indicators?.length ?? 0) === 0,
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const LC = (
      globalThis as {
        LightweightCharts?: {
          createSeriesMarkers?: <T>(s: ISeriesApi<"Candlestick">) => {
            setMarkers: (m: SeriesMarker<T>[]) => void;
          };
        };
      }
    ).LightweightCharts;
    if (LC?.createSeriesMarkers) {
      markersPluginRef.current = LC.createSeriesMarkers(candleSeries);
    }

    props.onChartReady?.(chart);

    const onResize = (): void => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      // Defer dispose by one rAF so any pending series cleanup completes
      // on a still-alive chart (see replay-chart.tsx for the original
      // "Object is disposed" bug inside TimeAxisWidget._paint).
      requestAnimationFrame(() => {
        try {
          dispose();
        } catch {
          // already disposed.
        }
      });
      chartRef.current = null;
      candleSeriesRef.current = null;
      markersPluginRef.current = null;
    };
  }, []);

  // Push candle data.
  useEffect(() => {
    candleSeriesRef.current?.setData(props.candles);
  }, [props.candles]);

  // Apply indicators (rebuild on visibility / data change).
  const candleTimes = useMemo(() => props.candles.map((c) => c.time), [props.candles]);
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleSeriesRef.current;
    const markersPlugin = markersPluginRef.current;
    if (!chart || !candle) return;

    for (const c of indicatorCleanupsRef.current) c.cleanup();
    indicatorCleanupsRef.current = [];
    indicatorMarkersRef.current = [];

    const ind = props.indicators ?? [];
    const alloc = allocatePanes(
      ind.map((i) => ({
        id: i.id,
        pane: i.plugin.renderConfig.pane,
        secondaryPaneStretch: i.plugin.renderConfig.secondaryPaneStretch,
      })),
      visibility,
    );

    for (const i of ind) {
      const paneIndex = alloc.assignments[i.id];
      if (paneIndex === undefined) continue;
      const result = applyContribution(chart, i.contribution, {
        id: i.id,
        renderConfig: i.plugin.renderConfig,
        paneIndex,
        candleTimes,
        mainSeries: candle,
        markerBucket: indicatorMarkersRef.current,
      });
      indicatorCleanupsRef.current.push(result);
    }

    for (const [idx, stretch] of alloc.stretches) {
      chart.panes()[idx]?.setStretchFactor(stretch);
    }

    const priceOverlayLineCount = ind.reduce((acc, i) => {
      if (!visibility[i.id]) return acc;
      if (i.plugin.renderConfig.pane !== "price_overlay") return acc;
      return acc + countLines(i.contribution);
    }, 0);
    applyRightOffset(chart, {
      priceOverlayLineCount,
      priceLineCount: props.priceLines?.length ?? 0,
    });

    const merged: SeriesMarker<Time>[] = [...indicatorMarkersRef.current];
    for (const m of props.markers ?? []) {
      merged.push({
        time: m.time,
        position: m.position,
        color: m.color,
        shape: m.shape,
        text: m.text,
      });
    }
    markersPlugin?.setMarkers(merged);

    return () => {
      for (const c of indicatorCleanupsRef.current) c.cleanup();
      indicatorCleanupsRef.current = [];
    };
  }, [props.indicators, visibility, candleTimes, props.priceLines, props.markers]);

  // Apply caller-provided priceLines.
  useEffect(() => {
    const candle = candleSeriesRef.current;
    if (!candle) return;
    for (const { series, line } of priceLinesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        /* ignore */
      }
    }
    priceLinesRef.current = [];
    for (const pl of props.priceLines ?? []) {
      priceLinesRef.current.push({
        series: candle,
        line: candle.createPriceLine({
          price: pl.price,
          color: pl.color,
          lineWidth: 1,
          lineStyle: pl.style ?? 0,
          axisLabelVisible: true,
          title: pl.title,
        }),
      });
    }
  }, [props.priceLines]);

  // Fullscreen.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(async () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (document.fullscreenElement === wrapper) await document.exitFullscreen();
    else await wrapper.requestFullscreen();
  }, []);
  useEffect(() => {
    if (!enableFullscreen) return;
    const onChange = (): void => {
      const fs = document.fullscreenElement === wrapperRef.current;
      setIsFullscreen(fs);
      const wrapper = wrapperRef.current;
      if (chartRef.current && wrapper) {
        chartRef.current.applyOptions({
          width: wrapper.clientWidth,
          height: fs ? window.innerHeight - 16 : height,
        });
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "F11" && wrapperRef.current) {
        e.preventDefault();
        void toggleFullscreen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("keydown", onKey);
    };
  }, [enableFullscreen, height, toggleFullscreen]);

  const chipEntries = useMemo(
    () =>
      (props.indicators ?? []).map((i) => ({
        id: i.id,
        displayName: i.plugin.displayName,
        swatch: i.plugin.renderConfig.palette[0] ?? "#94a3b8",
      })),
    [props.indicators],
  );

  return (
    <div
      ref={wrapperRef}
      data-testid="trading-view-chart"
      className={cn(
        "relative w-full bg-card border border-border rounded-md overflow-hidden",
        isFullscreen && "rounded-none border-0",
        props.className,
      )}
    >
      {enableControls ? (
        <IndicatorControlPanel
          entries={chipEntries}
          visibility={visibility}
          layout={controlsLayout}
          onToggle={(id, v) => setVisibility((s) => ({ ...s, [id]: v }))}
          onShowAll={() => setVisibility(Object.fromEntries(chipEntries.map((e) => [e.id, true])))}
          onShowNone={() =>
            setVisibility(Object.fromEntries(chipEntries.map((e) => [e.id, false])))
          }
        />
      ) : null}
      <div ref={containerRef} className="w-full" />
      {enableFullscreen ? (
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute top-2 right-2 z-10 inline-flex items-center justify-center size-7 rounded-md border border-border bg-card/85 backdrop-blur text-muted-foreground hover:text-foreground"
          title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        >
          {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      ) : null}
    </div>
  );
}

function countLines(c: IndicatorSeriesContribution): number {
  if (c.kind === "lines") return Object.keys(c.series).length;
  if (c.kind === "compound") return c.parts.reduce((acc, p) => acc + countLines(p), 0);
  if (c.kind === "priceLines") return c.lines.length;
  return 0;
}
