export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("atr", {
    chartPane: "secondary",
    secondaryPaneStretch: 11,
    addToChart(chart, paneIndex) {
      return {
        atr: chart.addSeries(LC.LineSeries, { color: "#ffca28", lineWidth: 1, lastValueVisible: true, title: "ATR(14)" }, paneIndex),
        atrMa20: chart.addSeries(LC.LineSeries, { color: "#888", lineWidth: 1, lastValueVisible: false, title: "ATR MA20" }, paneIndex),
      };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const fmt = (arr) => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.atr.setData(fmt(contribution.series.atr));
      handles.atrMa20.setData(fmt(contribution.series.atrMa20));
    },
  });
})();
`;
