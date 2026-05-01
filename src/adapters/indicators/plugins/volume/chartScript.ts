export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("volume", {
    chartPane: "secondary",
    secondaryPaneStretch: 13,
    addToChart(chart, paneIndex) {
      return {
        hist: chart.addSeries(LC.HistogramSeries, {
          priceFormat: { type: "volume" },
          priceLineVisible: false, lastValueVisible: false,
        }, paneIndex),
        ma20: chart.addSeries(LC.LineSeries, {
          color: "#ab47bc", lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
          title: "Vol MA20",
        }, paneIndex),
      };
    },
    setData(handles, contribution, candles) {
      handles.hist.setData(candles.map((c) => ({
        time: c.time, value: c.volume,
        color: c.close >= c.open ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
      })));
      if (contribution.kind === "lines" && contribution.series.volumeMa20) {
        handles.ma20.setData(contribution.series.volumeMa20
          .map((v, i) => v == null ? null : { time: candles[i].time, value: v })
          .filter(Boolean));
      }
    },
  });
})();
`;
