import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";
import {
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineSeries,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

/**
 * Apply one indicator's `IndicatorSeriesContribution` to a lightweight-charts
 * v5 chart. Pure helper — returned `cleanup()` removes everything the
 * application created so the parent effect can re-apply on data change
 * without leaking series, price lines, or panes.
 *
 * Dispatch by `kind` :
 *   - `lines`      → one `addSeries(LineSeries)` per named series, on the
 *                    main pane for `price_overlay` indicators or in a
 *                    dedicated secondary pane otherwise. Series data is
 *                    aligned to `candleTimes` (null values produce gaps).
 *   - `priceLines` → `createPriceLine` on the main candle series. Always
 *                    on the price pane regardless of the plugin's hint.
 *   - `markers`    → pushed into `markerBucket` — the parent merges them
 *                    with event markers in a single `setMarkers()` call.
 *   - `histogram`  → one `addSeries(HistogramSeries)` in a secondary pane.
 *   - `compound`   → recurse for each part.
 *
 * Color palettes are kept per-id so RSI lines stay blue, EMA stacks
 * stay green/orange/red, etc. Caller is expected to pass a stable
 * `colorPalette` per indicator id so multi-series indicators (EMA stack
 * has 3 lines) get distinct strokes.
 */

export type IndicatorPane = "price_overlay" | "secondary";

export type ApplyIndicatorOpts = {
  /** Plugin id — used as a stable id-prefix for cleanup and color picking. */
  id: string;
  /** Pane hint from the backend. */
  pane: IndicatorPane;
  /** Candle timestamps (UTC seconds) — used to align line/histogram values. */
  candleTimes: UTCTimestamp[];
  /** Main candle series — used for `priceLines` and as `attachTo` for
   *  `price_overlay` line indicators that share the main scale. */
  mainSeries: ISeriesApi<"Candlestick">;
  /** Mutable marker bucket — markers from this indicator are pushed in. */
  markerBucket: SeriesMarker<Time>[];
  /** Stable per-series color sequence ; index N maps to series #N. */
  colorPalette: string[];
};

export type ApplyIndicatorResult = {
  cleanup(): void;
};

const MAIN_PANE_INDEX = 0;

export function applyIndicatorToChart(
  chart: IChartApi,
  contribution: IndicatorSeriesContribution,
  opts: ApplyIndicatorOpts,
): ApplyIndicatorResult {
  const createdSeries: ISeriesApi<"Line" | "Histogram">[] = [];
  const createdPriceLines: { series: ISeriesApi<"Candlestick">; line: IPriceLine }[] = [];

  function pickColor(index: number): string {
    const palette = opts.colorPalette;
    if (palette.length === 0) return "#94a3b8";
    return palette[index % palette.length] as string;
  }

  function nextSecondaryPaneIndex(): number {
    // lightweight-charts v5 auto-creates a pane when you target an index
    // that doesn't exist yet. We start fresh after the main (0) and let
    // the parent merge multiple indicators into the same secondary pane
    // when called repeatedly — for simplicity here we just take "next
    // available" by counting current panes.
    return chart.panes().length;
  }

  function applyOne(c: IndicatorSeriesContribution): void {
    switch (c.kind) {
      case "lines": {
        const entries = Object.entries(c.series);
        // Allocate a pane index up-front so multiple line groups in the
        // same indicator land on the same secondary pane (RSI never
        // mixes with MACD just because both are secondary).
        const targetPaneIndex =
          opts.pane === "price_overlay" ? MAIN_PANE_INDEX : nextSecondaryPaneIndex();
        entries.forEach(([name, values], idx) => {
          const color = pickColor(idx);
          const series = chart.addSeries(
            LineSeries,
            {
              color,
              lineWidth: 2,
              priceLineVisible: false,
              lastValueVisible: false,
              title: `${opts.id}:${name}`,
            },
            targetPaneIndex,
          );
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
            axisLabelVisible: true,
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
        const paneIndex = nextSecondaryPaneIndex();
        const series = chart.addSeries(
          HistogramSeries,
          {
            priceLineVisible: false,
            lastValueVisible: false,
            title: opts.id,
          },
          paneIndex,
        );
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
          // chart already torn down — silently ignore.
        }
      }
      for (const { series, line } of createdPriceLines) {
        try {
          series.removePriceLine(line);
        } catch {
          // ignore — series may already be gone.
        }
      }
    },
  };
}

/**
 * Align a `(number | null)[]` to the candle timeline. Nulls become gaps
 * (`whitespace` data points in lightweight-charts terms). Exposed for
 * unit tests of the helper's data-shaping logic.
 */
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
