export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("fvg", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex, ctx) {
      return { candleSeries: ctx.candleSeries, lines: [] };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "priceLines") return;
      // Remove previous (idempotent re-renders not used in v1, but defensive).
      for (const l of handles.lines) handles.candleSeries.removePriceLine(l);
      handles.lines = contribution.lines.map((l) =>
        handles.candleSeries.createPriceLine({
          price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style,
          axisLabelVisible: true, title: l.title,
        }));
    },
  });
})();
`;
