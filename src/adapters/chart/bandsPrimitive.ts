import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Time,
} from "lightweight-charts";

export type Band = {
  topPrice: number;
  bottomPrice: number;
  /** rgba or hex. Alpha < 0.4 to avoid hiding candles. */
  fillColor: string;
  label?: string;
  fromTime?: Time | number;
  toTime?: Time | number;
};

/**
 * Canvas-based price-bands primitive (Fib zones, volume profile fills, ...).
 * Lives in the candle pane's framebuffer — same context that draws the
 * candles, so it renders identically in the React frontend and the
 * Playwright backend. Replaces the HTML overlay `PriceBandsOverlay.tsx`.
 *
 * z-order = "bottom" : bands sit BELOW the candles, never mask price action.
 */
export class BandsPrimitive implements ISeriesPrimitive<Time> {
  constructor(
    private readonly series: ISeriesApi<"Candlestick">,
    private bands: Band[],
  ) {}

  paneViews(): readonly IPrimitivePaneView[] {
    const view: IPrimitivePaneView = {
      zOrder: () => "bottom",
      renderer: () => new BandsRenderer(this.series, this.bands),
    };
    return [view];
  }

  setBands(bands: Band[]): void {
    this.bands = bands;
  }
}

class BandsRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly series: ISeriesApi<"Candlestick">,
    private readonly bands: Band[],
  ) {}

  draw(target: {
    useBitmapCoordinateSpace: (
      cb: (scope: {
        context: CanvasRenderingContext2D;
        bitmapSize: { width: number; height: number };
      }) => void,
    ) => void;
  }): void {
    // biome-ignore lint/correctness/useHookAtTopLevel: useBitmapCoordinateSpace is a lightweight-charts API, not a React hook
    target.useBitmapCoordinateSpace(({ context, bitmapSize }) => {
      const ts = (
        this.series as unknown as {
          chart: () => {
            timeScale: () => {
              timeToCoordinate: (t: Time | number) => number | null;
            };
          };
        }
      )
        .chart()
        .timeScale();
      for (const band of this.bands) {
        const y1 = this.series.priceToCoordinate(band.topPrice);
        const y2 = this.series.priceToCoordinate(band.bottomPrice);
        if (y1 == null || y2 == null) continue;
        const x1 = band.fromTime != null ? (ts.timeToCoordinate(band.fromTime) ?? 0) : 0;
        const x2 =
          band.toTime != null
            ? (ts.timeToCoordinate(band.toTime) ?? bitmapSize.width)
            : bitmapSize.width;
        context.fillStyle = band.fillColor;
        context.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
      }
    });
  }
}
