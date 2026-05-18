import { describe, expect, test } from "bun:test";
import type { IndicatorSeriesContribution, RenderConfig } from "@domain/charts/types";

describe("IndicatorSeriesContribution (domain)", () => {
  test("compound part variant accepted", () => {
    const c: IndicatorSeriesContribution = {
      kind: "compound",
      parts: [
        { kind: "lines", series: { ema: [1, 2, 3] } },
        { kind: "priceLines", lines: [{ price: 100, color: "#fff", style: 0, title: "TP" }] },
      ],
    };
    expect(c.kind).toBe("compound");
  });

  test("bands variant has optional fromTime/toTime", () => {
    const c: IndicatorSeriesContribution = {
      kind: "bands",
      bands: [{ topPrice: 110, bottomPrice: 100, fillColor: "rgba(255,0,0,0.2)" }],
    };
    if (c.kind !== "bands") throw new Error();
    expect(c.bands[0]?.fromTime).toBeUndefined();
  });
});

describe("RenderConfig (domain)", () => {
  test("minimal shape", () => {
    const cfg: RenderConfig = {
      pane: "price_overlay",
      palette: ["#3b82f6", "#f59e0b"],
    };
    expect(cfg.palette.length).toBe(2);
  });

  test("with seriesLabels + secondaryPaneStretch", () => {
    const cfg: RenderConfig = {
      pane: "secondary",
      palette: ["#14b8a6"],
      seriesLabels: { rsi: "RSI" },
      secondaryPaneStretch: 13,
    };
    expect(cfg.seriesLabels?.rsi).toBe("RSI");
    expect(cfg.secondaryPaneStretch).toBe(13);
  });
});
