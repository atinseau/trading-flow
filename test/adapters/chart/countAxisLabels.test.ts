import { describe, expect, test } from "bun:test";
import { countAxisLabels, maxAxisLabelLength } from "@adapters/chart/countAxisLabels";
import type { IndicatorSeriesContribution } from "@domain/charts/types";

describe("countAxisLabels", () => {
  test("lines → one label per series", () => {
    const c: IndicatorSeriesContribution = {
      kind: "lines",
      series: { emaShort: [1, 2], emaMid: [1, 2], emaLong: [1, 2] },
    };
    expect(countAxisLabels(c)).toBe(3);
  });

  test("priceLines → only non-empty titles", () => {
    const c: IndicatorSeriesContribution = {
      kind: "priceLines",
      lines: [
        { price: 100, color: "#fff", style: 0, title: "HH" },
        { price: 90, color: "#fff", style: 0, title: "LL" },
        // FVG band lines emitted with title="" → invisible on axis
        { price: 95, color: "#fff", style: 0, title: "" },
        { price: 92, color: "#fff", style: 0, title: "" },
      ],
    };
    expect(countAxisLabels(c)).toBe(2);
  });

  test("markers and bands contribute 0", () => {
    expect(
      countAxisLabels({
        kind: "markers",
        markers: [
          { index: 1, position: "above", color: "#f00", shape: "arrowUp", text: "H" },
        ],
      }),
    ).toBe(0);
    expect(
      countAxisLabels({
        kind: "bands",
        bands: [{ topPrice: 100, bottomPrice: 90, fillColor: "rgba(0,0,0,0.1)" }],
      }),
    ).toBe(0);
  });

  test("histogram → 1 label", () => {
    expect(countAxisLabels({ kind: "histogram", values: [1, 2, 3] })).toBe(1);
  });

  test("compound sums parts (fibonacci-shaped)", () => {
    const fibLike: IndicatorSeriesContribution = {
      kind: "compound",
      parts: [
        {
          kind: "priceLines",
          lines: [
            { price: 1, color: "#fff", style: 0, title: "Fib anchor H" },
            { price: 2, color: "#fff", style: 0, title: "Fib anchor L" },
            { price: 3, color: "#fff", style: 2, title: "Fib 0.382" },
            { price: 4, color: "#fff", style: 2, title: "Fib 0.500" },
            { price: 5, color: "#fff", style: 2, title: "Fib 0.618" },
            { price: 6, color: "#fff", style: 1, title: "Fib 1.272" },
            { price: 7, color: "#fff", style: 1, title: "Fib 1.618" },
          ],
        },
        { kind: "bands", bands: [{ topPrice: 1, bottomPrice: 2, fillColor: "rgba(0,0,0,0.1)" }] },
        {
          kind: "markers",
          markers: [
            { index: 1, position: "above", color: "#f00", shape: "arrowDown", text: "SH" },
          ],
        },
      ],
    };
    expect(countAxisLabels(fibLike)).toBe(7);
  });

  test("rsi-shaped: lines + invisible anchor priceLines", () => {
    // RSI emits invisible priceLines at 0 / 100 (autoScale anchors) and at
    // 70/30 with empty titles — none should be counted.
    const rsiLike: IndicatorSeriesContribution = {
      kind: "compound",
      parts: [
        { kind: "lines", series: { rsi: [50, 51, 49] } },
        {
          kind: "priceLines",
          lines: [
            { price: 70, color: "#aaa", style: 1, title: "" },
            { price: 30, color: "#aaa", style: 1, title: "" },
            { price: 100, color: "rgba(0,0,0,0)", style: 0, title: "" },
            { price: 0, color: "rgba(0,0,0,0)", style: 0, title: "" },
          ],
        },
      ],
    };
    expect(countAxisLabels(rsiLike)).toBe(1);
  });

  test("empty contributions count as 0", () => {
    expect(countAxisLabels({ kind: "compound", parts: [] })).toBe(0);
    expect(countAxisLabels({ kind: "lines", series: {} })).toBe(0);
    expect(countAxisLabels({ kind: "priceLines", lines: [] })).toBe(0);
  });
});

describe("maxAxisLabelLength", () => {
  test("lines → longest series label via seriesLabels", () => {
    const c: IndicatorSeriesContribution = {
      kind: "lines",
      series: { emaShort: [], emaMid: [], emaLong: [] },
    };
    expect(
      maxAxisLabelLength("ema_stack", c, {
        seriesLabels: { emaShort: "EMA short", emaMid: "EMA mid", emaLong: "EMA long" },
      }),
    ).toBe("EMA short".length); // 9
  });

  test("lines without seriesLabels → fallback `id:name`", () => {
    const c: IndicatorSeriesContribution = {
      kind: "lines",
      series: { foo: [], bar: [] },
    };
    expect(maxAxisLabelLength("myplugin", c, { seriesLabels: undefined })).toBe(
      "myplugin:bar".length, // 12
    );
  });

  test("priceLines → longest non-empty title", () => {
    const c: IndicatorSeriesContribution = {
      kind: "priceLines",
      lines: [
        { price: 1, color: "#fff", style: 0, title: "HH" },
        { price: 2, color: "#fff", style: 0, title: "LL" },
        { price: 3, color: "#fff", style: 0, title: "" },
      ],
    };
    expect(maxAxisLabelLength("structure_levels", c, { seriesLabels: {} })).toBe(2);
  });

  test("compound (fibonacci shape) → 'Fib anchor H' = 12", () => {
    const fib: IndicatorSeriesContribution = {
      kind: "compound",
      parts: [
        {
          kind: "priceLines",
          lines: [
            { price: 1, color: "#fff", style: 0, title: "Fib anchor H" },
            { price: 2, color: "#fff", style: 0, title: "Fib 0.618" },
          ],
        },
        { kind: "bands", bands: [{ topPrice: 1, bottomPrice: 2, fillColor: "rgba(0,0,0,0.1)" }] },
      ],
    };
    expect(maxAxisLabelLength("fibonacci", fib, { seriesLabels: {} })).toBe(12);
  });

  test("histogram → seriesLabels.histogram or id", () => {
    expect(
      maxAxisLabelLength(
        "volume",
        { kind: "histogram", values: [] },
        { seriesLabels: { histogram: "Volume" } },
      ),
    ).toBe("Volume".length);
    expect(
      maxAxisLabelLength("vol", { kind: "histogram", values: [] }, { seriesLabels: {} }),
    ).toBe("vol".length);
  });

  test("empty contributions → 0", () => {
    expect(maxAxisLabelLength("x", { kind: "compound", parts: [] }, { seriesLabels: {} })).toBe(0);
    expect(maxAxisLabelLength("x", { kind: "priceLines", lines: [] }, { seriesLabels: {} })).toBe(
      0,
    );
  });
});
