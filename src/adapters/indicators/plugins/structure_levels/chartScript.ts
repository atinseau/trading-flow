export const CHART_SCRIPT = `
(() => {
  window.__registerPlugin("structure_levels", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex, ctx) {
      return { candleSeries: ctx.candleSeries, lines: [] };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "priceLines") return;
      for (const l of handles.lines) handles.candleSeries.removePriceLine(l);
      handles.lines = contribution.lines.map((l) =>
        handles.candleSeries.createPriceLine({
          price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style,
          axisLabelVisible: l.title !== "", title: l.title,
        }));
    },
  });
})();
`;
