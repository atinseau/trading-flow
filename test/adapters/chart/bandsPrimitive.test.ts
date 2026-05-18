import { describe, expect, test } from "bun:test";
import { type Band, BandsPrimitive } from "@adapters/chart/bandsPrimitive";

function fakeSeries() {
  return {
    priceToCoordinate: (price: number) => price * 2,
  };
}

function fakeChart() {
  return {
    timeScale: () => ({
      timeToCoordinate: (t: number) => t,
    }),
  };
}

describe("BandsPrimitive", () => {
  test("paneViews() returns a single view with zOrder=bottom", () => {
    // biome-ignore lint/suspicious/noExplicitAny: typed at construction time, but the fake doesn't fully implement ISeriesApi
    const series = fakeSeries() as any;
    const bands: Band[] = [{ topPrice: 110, bottomPrice: 100, fillColor: "rgba(255,0,0,0.2)" }];
    const p = new BandsPrimitive(series, bands);
    // Simulate the attached() lifecycle hook — primitives receive the chart
    // ref via SeriesAttachedParameter, not via series.chart() (that method
    // doesn't exist in lightweight-charts v5).
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake of SeriesAttachedParameter
    p.attached({ chart: fakeChart() as any, series, requestUpdate: () => {} } as any);
    const views = p.paneViews();
    expect(views.length).toBe(1);
    expect(views[0]?.zOrder?.()).toBe("bottom");
  });

  test("renderer.draw() calls fillRect once per band with correct coords", () => {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const series = fakeSeries() as any;
    const bands: Band[] = [
      { topPrice: 110, bottomPrice: 100, fillColor: "rgba(255,0,0,0.2)" },
      {
        topPrice: 105,
        bottomPrice: 95,
        fillColor: "rgba(0,255,0,0.2)",
        fromTime: 100,
        toTime: 200,
      },
    ];
    const p = new BandsPrimitive(series, bands);
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake of SeriesAttachedParameter
    p.attached({ chart: fakeChart() as any, series, requestUpdate: () => {} } as any);
    const renderer = p.paneViews()[0]?.renderer();
    const fillRectCalls: Array<{ x: number; y: number; w: number; h: number; style: string }> = [];
    const fakeTarget = {
      useBitmapCoordinateSpace: (
        cb: (scope: { context: unknown; bitmapSize: { width: number; height: number } }) => void,
      ) => {
        const ctx = {
          set fillStyle(v: string) {
            (ctx as unknown as { _fill: string })._fill = v;
          },
          get fillStyle() {
            return (ctx as unknown as { _fill: string })._fill;
          },
          fillRect: (x: number, y: number, w: number, h: number) =>
            fillRectCalls.push({ x, y, w, h, style: (ctx as unknown as { _fill: string })._fill }),
        };
        cb({ context: ctx, bitmapSize: { width: 1000, height: 500 } });
      },
    };
    renderer?.draw(fakeTarget as never);
    expect(fillRectCalls.length).toBe(2);
    // Band 1: full width (no fromTime/toTime).
    expect(fillRectCalls[0]).toMatchObject({ x: 0, w: 1000, style: "rgba(255,0,0,0.2)" });
    // Band 2: bounded fromTime=100, toTime=200.
    expect(fillRectCalls[1]).toMatchObject({ x: 100, w: 100, style: "rgba(0,255,0,0.2)" });
  });
});
