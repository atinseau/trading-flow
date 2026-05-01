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
        emaShort: mk("#42a5f5", 1, "EMA Short"),
        emaMid: mk("#ffa726", 1, "EMA Mid"),
        emaLong: mk("#ef5350", 2, "EMA Long"),
      };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const fmt = (arr) => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.emaShort.setData(fmt(contribution.series.emaShort));
      handles.emaMid.setData(fmt(contribution.series.emaMid));
      handles.emaLong.setData(fmt(contribution.series.emaLong));
    },
  });
})();
`;
