import type { IndicatorSeriesContribution, RenderConfig } from "@domain/charts/types";
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import { BandsPrimitive } from "./bandsPrimitive";

// RenderConfig lives in @domain/charts/types — re-exported here for
// adapter-side convenience.
export type { RenderConfig } from "@domain/charts/types";

export type ApplyContributionOpts = {
  id: string;
  renderConfig: RenderConfig;
  /** Pane index resolved by `paneAllocator`. 0 = main pane. */
  paneIndex: number;
  candleTimes: UTCTimestamp[];
  mainSeries: ISeriesApi<"Candlestick">;
  /** Mutable bucket — markers from this indicator are pushed in. The
   *  parent commits all markers in one createSeriesMarkers() call. */
  markerBucket: SeriesMarker<Time>[];
};

export type ApplyContributionResult = {
  cleanup(): void;
};

function readLC(): {
  LineSeries: unknown;
  HistogramSeries: unknown;
} {
  const lc = (globalThis as { LightweightCharts?: unknown }).LightweightCharts as
    | { LineSeries: unknown; HistogramSeries: unknown }
    | undefined;
  if (!lc) {
    throw new Error(
      "[contributionRenderer] globalThis.LightweightCharts is undefined. " +
        "Import `@client/lib/setupLightweightChartsGlobal` at boot, " +
        "or ensure the standalone bundle is injected before invoking the Playwright renderer.",
    );
  }
  return lc;
}

export function applyContribution(
  chart: IChartApi,
  contribution: IndicatorSeriesContribution,
  opts: ApplyContributionOpts,
): ApplyContributionResult {
  const LC = readLC();
  const createdSeries: ISeriesApi<"Line" | "Histogram">[] = [];
  const createdPriceLines: Array<{ series: ISeriesApi<"Candlestick">; line: IPriceLine }> = [];
  const createdPrimitives: Array<{
    series: ISeriesApi<"Candlestick">;
    primitive: ISeriesPrimitive<Time>;
  }> = [];

  function pickColor(index: number): string {
    const palette = opts.renderConfig.palette;
    if (palette.length === 0) return "#94a3b8";
    return palette[index % palette.length] as string;
  }

  function labelFor(name: string): string {
    return opts.renderConfig.seriesLabels?.[name] ?? `${opts.id}:${name}`;
  }

  function applyOne(c: IndicatorSeriesContribution): void {
    switch (c.kind) {
      case "lines": {
        const entries = Object.entries(c.series);
        entries.forEach(([name, values], idx) => {
          const series = chart.addSeries(
            LC.LineSeries as never,
            {
              color: pickColor(idx),
              lineWidth: 2,
              priceLineVisible: false,
              lastValueVisible: false,
              title: labelFor(name),
            },
            opts.paneIndex,
          ) as ISeriesApi<"Line">;
          const data = alignToTimes(opts.candleTimes, values);
          series.setData(data);
          createdSeries.push(series);
        });
        return;
      }
      case "priceLines": {
        for (const line of c.lines) {
          const created = opts.mainSeries.createPriceLine({
            price: line.price,
            color: line.color,
            lineWidth: 1,
            lineStyle: line.style,
            axisLabelVisible: line.title !== "",
            title: line.title,
          });
          createdPriceLines.push({ series: opts.mainSeries, line: created });
        }
        return;
      }
      case "markers": {
        for (const m of c.markers) {
          const t = opts.candleTimes[m.index];
          if (t === undefined) continue;
          opts.markerBucket.push({
            time: t,
            position: m.position === "above" ? "aboveBar" : "belowBar",
            shape: m.shape,
            color: m.color,
            text: m.text,
          });
        }
        return;
      }
      case "histogram": {
        const series = chart.addSeries(
          LC.HistogramSeries as never,
          {
            priceLineVisible: false,
            lastValueVisible: false,
            title: opts.id,
          },
          opts.paneIndex,
        ) as ISeriesApi<"Histogram">;
        const data = c.values
          .map((v, i) => {
            const time = opts.candleTimes[i];
            if (time === undefined || v === null) return null;
            if (typeof v === "number") return { time, value: v };
            return { time, value: v.value, color: v.color };
          })
          .filter((d): d is { time: UTCTimestamp; value: number; color?: string } => d !== null);
        series.setData(data);
        createdSeries.push(series);
        return;
      }
      case "bands": {
        const primitive = new BandsPrimitive(opts.mainSeries, c.bands);
        opts.mainSeries.attachPrimitive(primitive);
        createdPrimitives.push({ series: opts.mainSeries, primitive });
        return;
      }
      case "compound": {
        for (const part of c.parts) applyOne(part);
        return;
      }
    }
  }

  applyOne(contribution);

  return {
    cleanup() {
      for (const s of createdSeries) {
        try {
          chart.removeSeries(s);
        } catch {
          // chart already torn down — ignore.
        }
      }
      for (const { series, line } of createdPriceLines) {
        try {
          series.removePriceLine(line);
        } catch {
          // ignore.
        }
      }
      for (const { series, primitive } of createdPrimitives) {
        try {
          series.detachPrimitive(primitive);
        } catch {
          // ignore.
        }
      }
    },
  };
}

export function alignToTimes(
  times: UTCTimestamp[],
  values: (number | null)[],
): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = [];
  const n = Math.min(times.length, values.length);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const t = times[i];
    if (v === null || v === undefined || t === undefined) continue;
    out.push({ time: t, value: v });
  }
  return out;
}
