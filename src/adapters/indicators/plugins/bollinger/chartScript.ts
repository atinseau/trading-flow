export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("bollinger", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex) {
      const mk = (title) => chart.addSeries(LC.LineSeries, {
        color: "rgba(156, 156, 156, 0.6)", lineWidth: 1, lineStyle: 2,
        priceLineVisible: false, lastValueVisible: false, title,
      }, paneIndex);
      return { upper: mk("BB Up"), lower: mk("BB Lo") };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const fmt = (arr) => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.upper.setData(fmt(contribution.series.upper));
      handles.lower.setData(fmt(contribution.series.lower));
    },
  });
})();
`;
