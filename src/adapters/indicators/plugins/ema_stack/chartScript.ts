export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("ema_stack", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex) {
      const mk = (color, lineWidth, title) => chart.addSeries(LC.LineSeries, {
        color, lineWidth, priceLineVisible: false, lastValueVisible: false, title,
      }, paneIndex);
      return {
        ema20: mk("#42a5f5", 1, "EMA20"),
        ema50: mk("#ffa726", 1, "EMA50"),
        ema200: mk("#ef5350", 2, "EMA200"),
      };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const fmt = (arr) => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.ema20.setData(fmt(contribution.series.ema20));
      handles.ema50.setData(fmt(contribution.series.ema50));
      handles.ema200.setData(fmt(contribution.series.ema200));
    },
  });
})();
`;
