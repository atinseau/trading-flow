export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("rsi", {
    chartPane: "secondary",
    secondaryPaneStretch: 13,
    addToChart(chart, paneIndex) {
      const rsi = chart.addSeries(LC.LineSeries, {
        color: "#ce93d8", lineWidth: 1, lastValueVisible: true,
        priceLineVisible: false, title: "RSI(14)",
      }, paneIndex);
      rsi.createPriceLine({ price: 70, color: "#666", lineWidth: 1, lineStyle: 2,
                            axisLabelVisible: false, title: "" });
      rsi.createPriceLine({ price: 30, color: "#666", lineWidth: 1, lineStyle: 2,
                            axisLabelVisible: false, title: "" });
      return { rsi };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const arr = contribution.series.rsi || [];
      const data = arr
        .map((v, i) => v == null ? null : { time: candles[i].time, value: v })
        .filter(Boolean);
      handles.rsi.setData(data);
    },
  });
})();
`;
