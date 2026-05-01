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
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      }, paneIndex);
      // Constrain the RSI pane to its theoretical range [0, 100]
      rsi.priceScale().applyOptions({
        autoScale: false,
        scaleMargins: { top: 0.05, bottom: 0.05 },
      });
      // Visible reference lines at overbought/oversold levels (upgraded visibility)
      rsi.createPriceLine({ price: 70, color: "#888", lineWidth: 1, lineStyle: 1,
                            axisLabelVisible: false, title: "" });
      rsi.createPriceLine({ price: 30, color: "#888", lineWidth: 1, lineStyle: 1,
                            axisLabelVisible: false, title: "" });
      // Invisible anchor lines at 0 and 100 to bound the autoscale range
      rsi.createPriceLine({ price: 100, color: "rgba(0,0,0,0)", lineWidth: 1, lineStyle: 0,
                            axisLabelVisible: false, title: "" });
      rsi.createPriceLine({ price: 0, color: "rgba(0,0,0,0)", lineWidth: 1, lineStyle: 0,
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
