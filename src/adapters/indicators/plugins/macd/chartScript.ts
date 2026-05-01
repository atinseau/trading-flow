export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("macd", {
    chartPane: "secondary",
    secondaryPaneStretch: 13,
    addToChart(chart, paneIndex) {
      return {
        macd: chart.addSeries(LC.LineSeries, { color: "#42a5f5", lineWidth: 1, lastValueVisible: true, title: "MACD" }, paneIndex),
        signal: chart.addSeries(LC.LineSeries, { color: "#ffa726", lineWidth: 1, lastValueVisible: false, title: "Signal" }, paneIndex),
        hist: chart.addSeries(LC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex),
      };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const fmt = (arr) => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.macd.setData(fmt(contribution.series.macd));
      handles.signal.setData(fmt(contribution.series.signal));
      handles.hist.setData((contribution.series.hist || [])
        .map((v, i) => v == null ? null : ({
          time: candles[i].time, value: v,
          color: v >= 0 ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
        }))
        .filter(Boolean));
    },
  });
})();
`;
