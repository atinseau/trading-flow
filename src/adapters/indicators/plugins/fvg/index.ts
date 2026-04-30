import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { fvgMetadata } from "./metadata";
import { computePriceLines } from "./compute";
import { detectorFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const fvgPlugin: IndicatorPlugin = {
  ...fvgMetadata,
  computeScalars: () => ({}), // no scalar
  computeSeries: (c) => ({ kind: "priceLines", lines: computePriceLines(c) }),
  scalarSchemaFragment: () => ({}),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
  breakdownAxes: ["structure"],
};
