export const CHART_SCRIPT = `
(() => {
  window.__registerPlugin("poc", {
    chartPane: "price_overlay",
    addToChart() { return {}; },
    setData() {},
  });
})();
`;
