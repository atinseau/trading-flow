export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("swings_bos", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex, ctx) {
      return { candleSeries: ctx.candleSeries };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "markers") return;
      const m = contribution.markers.map((mk) => ({
        time: candles[mk.index].time,
        position: mk.position === "above" ? "aboveBar" : "belowBar",
        color: mk.color, shape: mk.shape, text: mk.text,
      })).sort((a, b) => a.time - b.time);
      if (LC.createSeriesMarkers && m.length > 0) {
        LC.createSeriesMarkers(handles.candleSeries, m);
      }
    },
  });
})();
`;
