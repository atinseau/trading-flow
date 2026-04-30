export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("vwap", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex) {
      return { vwap: chart.addSeries(LC.LineSeries, {
        color: "#ffeb3b", lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
        title: "VWAP",
      }, paneIndex) };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const data = contribution.series.vwap.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.vwap.setData(data);
    },
  });
})();
`;
