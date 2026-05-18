import { ensureHappyDom } from "../../frontend/setup";

ensureHappyDom();

import { describe, expect, test } from "bun:test";
import type { RenderConfig } from "@adapters/chart/contributionRenderer";
import { TradingViewChart } from "@client/components/charts/TradingViewChart";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function stubLC() {
  (globalThis as { LightweightCharts?: unknown }).LightweightCharts = {
    LineSeries: "Line",
    HistogramSeries: "Histo",
    CandlestickSeries: "Candle",
    createChart: () => ({
      addSeries: () => ({
        setData: () => undefined,
        createPriceLine: () => ({}),
      }),
      timeScale: () => ({
        applyOptions: () => undefined,
        fitContent: () => undefined,
      }),
      panes: () => [{ setStretchFactor: () => undefined }],
      applyOptions: () => undefined,
      remove: () => undefined,
    }),
  };
}

const fakePlugin = (
  id: string,
  pane: "price_overlay" | "secondary" = "price_overlay",
): IndicatorPlugin & { renderConfig: RenderConfig } =>
  ({
    id: id as never,
    displayName: id.toUpperCase(),
    tag: "trend",
    shortDescription: "",
    longDescription: "",
    computeScalars: () => ({}),
    computeSeries: () => ({ kind: "lines", series: { a: [1, 2, 3] } }),
    scalarSchemaFragment: () => ({}),
    chartScript: "",
    chartPane: pane,
    getPromptData: () => null,
    renderConfig: { pane, palette: ["#ff0000"] },
  }) as unknown as IndicatorPlugin & { renderConfig: RenderConfig };

describe("<TradingViewChart>", () => {
  test("renders the chart wrapper + control panel when enableControls", () => {
    stubLC();
    render(
      <TradingViewChart
        candles={[]}
        indicators={[
          {
            id: "ema_stack",
            plugin: fakePlugin("ema_stack"),
            contribution: { kind: "lines", series: { a: [1] } },
          },
        ]}
        enableControls
      />,
    );
    expect(screen.getByTestId("trading-view-chart")).toBeTruthy();
    expect(screen.getByTestId("indicator-control-panel")).toBeTruthy();
    cleanup();
  });

  test("when enableControls=false, no panel is rendered", () => {
    stubLC();
    render(
      <TradingViewChart
        candles={[]}
        indicators={[
          {
            id: "ema_stack",
            plugin: fakePlugin("ema_stack"),
            contribution: { kind: "lines", series: { a: [1] } },
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("indicator-control-panel")).toBeNull();
    cleanup();
  });

  test("toggling a chip flips visibility state on the chip element", () => {
    stubLC();
    render(
      <TradingViewChart
        candles={[]}
        indicators={[
          {
            id: "rsi",
            plugin: fakePlugin("rsi", "secondary"),
            contribution: { kind: "lines", series: { a: [1] } },
          },
        ]}
        enableControls
        initialVisibility={{ rsi: true }}
      />,
    );
    const chip = screen.getByTestId("indicator-chip-rsi");
    expect(chip.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-checked")).toBe("false");
    cleanup();
  });
});
