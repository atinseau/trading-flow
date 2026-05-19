/**
 * Domain contract for what an indicator produces, render-side. Pure data,
 * zero dependency on `lightweight-charts` (the type cannot live in
 * `adapters/` because both adapter contexts — React frontend, Playwright
 * backend — consume it).
 */
export type IndicatorSeriesContribution =
  | { kind: "lines"; series: Record<string, (number | null)[]> }
  | {
      kind: "histogram";
      values: ({ value: number; color: string } | number | null)[];
    }
  | {
      kind: "markers";
      markers: Array<{
        index: number;
        position: "above" | "below";
        text: string;
        color: string;
        shape: "arrowUp" | "arrowDown" | "circle" | "square";
      }>;
    }
  | {
      kind: "priceLines";
      lines: Array<{
        price: number;
        color: string;
        style: 0 | 1 | 2;
        title: string;
      }>;
    }
  | {
      kind: "bands";
      bands: Array<{
        topPrice: number;
        bottomPrice: number;
        /** Hex or `rgba(...)` — typically semi-transparent (alpha < 0.3). */
        fillColor: string;
        /** Optional in-band label at top-left. */
        label?: string;
        /** Unix seconds. Omitted = extends to the left edge. */
        fromTime?: number;
        /** Unix seconds. Omitted = extends to the right edge. */
        toTime?: number;
      }>;
    }
  | { kind: "compound"; parts: IndicatorSeriesContribution[] };

/**
 * Declarative render preferences attached to a plugin. The renderer
 * (contributionRenderer) reads this to decide pane / palette / labels —
 * the plugin never invokes lightweight-charts directly.
 *
 * Lives in domain (not adapter) because TWO adapter contexts consume it
 * (React frontend + Playwright backend) and both must see the SAME shape.
 */
export type RenderConfig = {
  pane: "price_overlay" | "secondary";
  /** Per-series colors. Index N → Nth named series in a `lines` kind. */
  palette: ReadonlyArray<string>;
  /** Optional human label per series name. Falls back to `"<id>:<name>"`. */
  seriesLabels?: Readonly<Record<string, string>>;
  /** Pixel stretch factor for secondary panes (defaults 13). */
  secondaryPaneStretch?: number;
  /** Optional per-series style overrides for `kind: "lines"`. Keyed by
   *  series name (same key as `seriesLabels`). Lets a plugin make the
   *  middle of a BB envelope dashed, an MA20 lighter than the raw line,
   *  etc. */
  linesStyles?: Readonly<
    Record<string, { lineWidth?: 1 | 2 | 3 | 4; lineStyle?: 0 | 1 | 2 | 3 | 4 }>
  >;
};
